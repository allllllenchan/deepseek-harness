/**
 * Model-facing `job_output`, `job_list`, and `job_kill` tools over
 * `ctx.jobs`. Loading the plugin attaches the controller required by
 * producers. It also delivers unreported completions to the owning agent:
 * injected into a busy owner's next step, or opening a turn on an idle one
 * under the default `wakeup` delivery, bounded per owner.
 * @module @deepseek-ai/dsh-tool-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type { Omitted } from '@deepseek-ai/dsh-output-retention'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const name = 'tool-jobs'
export const inject = ['tools', 'jobs', 'systemPrompt']

/**
 * How an unreported completion reaches an owner that is already idle: `wakeup`
 * opens a turn for it, `quiet` leaves it pending until something else wakes the
 * owner. A busy owner is injected either way.
 */
export type CompletionDelivery = 'quiet' | 'wakeup'

/** Configures bounded `job_output` waits and completion-notice delivery. */
export interface Config {
  /** Wait duration applied when `job_output` sets `wait` without `timeout_ms` (default 30s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied `timeout_ms` is clamped down to it (default 10min). */
  maxWaitTimeoutMs?: number
  /**
   * Cadence at which a `pattern` wait re-reads the job to test the pattern
   * (default 250ms). A lower value detects the match sooner; a higher one costs
   * fewer reads. The wait's own `timeout_ms` is unaffected.
   */
  patternPollIntervalMs?: number
  /** Whether a completion opens a turn on an idle owner (default `wakeup`). */
  completionDelivery?: CompletionDelivery
  /**
   * Turns one owner may have opened by completion wakes before the next
   * notice degrades to injection, reset by any user-authored input (default 3).
   * Bounds the self-exciting chain where a woken turn starts the job whose
   * completion wakes it again.
   */
  maxConsecutiveWakes?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(600_000),
  patternPollIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(250),
  completionDelivery: z.union(['quiet', 'wakeup'] as const).default('wakeup'),
  maxConsecutiveWakes: z.number().min(1).default(3),
})

/**
 * Bytes a `pattern` wait may accumulate before it starts dropping the oldest
 * ones. The model-facing budget is the caller's `max_bytes` or the producer's
 * `outputLimitBytes`; this ceiling only keeps a caller that asks for neither
 * from pinning an unbounded string, and the dropped count is reported in the
 * result rather than silently discarded.
 */
export const MAX_WAIT_RETENTION_BYTES = 1024 * 1024

/** Task state safe for model-authored programs; ownership/bookkeeping fields are omitted. */
export interface PublicJobSnapshot {
  id: string
  kind: string
  label: string
  status: JobSnapshot['status']
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** Shared schema for job-control outputs. */
const PUBLIC_TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['running', 'stopping', 'completed', 'killed', 'failed'],
    },
    detail: { type: 'string' },
    startedAt: { type: 'integer', required: true },
    finishedAt: { type: 'integer' },
  },
} as const

/** Remove job ownership and notification bookkeeping from a registry snapshot. */
function publicJob(snapshot: JobSnapshot): PublicJobSnapshot {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...snapshot.detail !== undefined ? { detail: snapshot.detail } : {},
    startedAt: snapshot.startedAt,
    ...snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {},
  }
}

/**
 * Render generic status with optional producer detail.
 * @param snapshot - job state to render.
 * @returns a bracketed status line.
 */
export function statusLine(snapshot: Pick<JobSnapshot, 'status' | 'detail'>): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

const encoder = new TextEncoder()

function retainTail(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function retainHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function fitWithSuffix(
  content: string,
  suffix: string,
  maxBytes: number | undefined,
  omitted: string,
): string {
  const complete = `${content}${suffix}`
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const fixed = `${content.endsWith(omitted.trimStart()) ? '' : omitted}${suffix}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes >= maxBytes) return retainTail(fixed, maxBytes)
  return `${retainTail(content, maxBytes - fixedBytes)}${fixed}`
}

/**
 * One-line account of a settled job for the `notice` form's collapsed row.
 * @param snapshot - the settled job.
 * @returns its kind, label, and status, bounded like every notice summary.
 */
function completionSummary(snapshot: JobSnapshot): string {
  return boundContextSummary(`${snapshot.kind} ${snapshot.label} ${statusLine(snapshot)}`)
}

function fitCompletionNotice(snapshot: JobSnapshot): string {
  const prefix = `background job ${snapshot.id}`
  const detail = ` (${snapshot.kind}: ${snapshot.label}) finished ${statusLine(snapshot)}`
  const action = '\nDone; job_output.'
  const complete = `${prefix}${detail}. Read its output with job_output.`
  const maxBytes = snapshot.outputLimitBytes
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const omitted = '\n[notice truncated]'
  const fixed = `${prefix}${omitted}${action}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes <= maxBytes) {
    return fixedBytes === maxBytes
      ? fixed
      : `${prefix}${retainHead(detail, maxBytes - fixedBytes)}${omitted}${action}`
  }
  const compact = `${prefix}${action}`
  const compactBytes = encoder.encode(compact).byteLength
  if (compactBytes <= maxBytes) return compact
  const actionBytes = encoder.encode(action).byteLength
  if (actionBytes >= maxBytes) return retainTail(action, maxBytes)
  return `${retainHead(prefix, maxBytes - actionBytes)}${action}`
}

function rawSingleText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (block?.type !== 'text') return undefined
  return block.text
}

function boundSingleText(content: readonly ContentBlock[], maxBytes: number): ContentBlock[] | undefined {
  const text = rawSingleText(content)
  if (text === undefined) return undefined
  return [{
    type: 'text',
    text: fitWithSuffix(text, '', maxBytes, '\n[result truncated]'),
  }]
}

function visibleOutputLimit(ctx: Context, exec: ToolExecution): number | undefined {
  if (exec.name !== 'job_output' && exec.name !== 'job_kill') return undefined
  const args = exec.arguments as { job_id?: unknown; max_bytes?: unknown } | null | undefined
  const jobId = args?.job_id
  if (typeof jobId !== 'string' || jobId.length === 0) return undefined
  const producerLimit = ctx.jobs.list(exec.agent).find(snapshot => snapshot.id === jobId)?.outputLimitBytes
  // Only `job_output` accepts a call-site byte budget, and it may only tighten
  // the producer's own cap: the smaller of the two bounds one complete result.
  if (exec.name !== 'job_output') return producerLimit
  const requested = args?.max_bytes
  if (!isPositiveInteger(requested)) return producerLimit
  return producerLimit === undefined ? requested : Math.min(producerLimit, requested)
}

/** Whether a model-supplied count is usable as a positive byte or line budget. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Validate one model-supplied budget, naming the offending field and value. */
function requirePositiveInteger(value: unknown, field: string): number {
  if (!isPositiveInteger(value)) {
    throw new Error(`invalid ${field}: expected a positive whole number, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Bound already-read output to its trailing `lines`.
 * @param text - the output read from the job.
 * @param lines - number of trailing lines to keep.
 * @returns the kept text and how many leading lines were dropped.
 */
function keepTrailingLines(text: string, lines: number): { text: string; omitted: number } {
  if (text.length === 0) return { text, omitted: 0 }
  // A trailing newline terminates the last line; it does not start an empty one.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const all = body.split('\n')
  if (all.length <= lines) return { text, omitted: 0 }
  return { text: all.slice(all.length - lines).join('\n'), omitted: all.length - lines }
}

/** The exact number of bytes a retainer dropped, or 0 when it dropped none. */
function omittedBytes(omitted: Omitted): number {
  return omitted.kind === 'exact' ? omitted.count : 0
}

/** One output read, plus the bytes a pattern wait dropped from its own retention window. */
interface JobOutputRead {
  text: string
  snapshot: JobSnapshot
  /** Bytes the wait's retention bound dropped before this text; 0 when none were. */
  waitOmittedBytes: number
}

/**
 * Wait for `pattern` while reading the job incrementally: each poll reads the
 * delta since the previous read, tests the pattern against the output read so
 * far, and stops at a match, at a terminal status, at the deadline, or on
 * caller cancellation. Every delta read is retained, so a match returns the
 * output consumed on the way to it rather than losing it.
 *
 * This stays the single consumer of the job's output cursor: the loop is one
 * `job_output` call reading repeatedly, exactly as a single read after a wait
 * did. Testing uses a carried suffix of the previous reads so a match split
 * across two deltas is still found.
 * @param ctx - context carrying the job registry.
 * @param id - the job to read.
 * @param exec - the calling tool execution (owner fence, aborted signal).
 * @param pattern - literal text that ends the wait.
 * @param timeoutMs - total wait budget across every poll.
 * @param pollMs - cadence between reads.
 * @param retentionBytes - bytes the accumulated output may hold before its oldest are dropped.
 * @returns the accumulated output, its final job state, and any dropped byte count.
 */
async function waitForPattern(
  ctx: Context,
  id: JobId,
  exec: ToolExecution,
  pattern: string,
  timeoutMs: number,
  pollMs: number,
  retentionBytes: number,
): Promise<JobOutputRead> {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes: retentionBytes })
  // A match may start in the previous read's last `pattern.length - 1` bytes.
  const carryLength = pattern.length - 1
  let probe = ''
  let snapshot = ctx.jobs.get(id, exec.agent)
  const deadlineAt = Date.now() + timeoutMs
  for (;;) {
    const read = ctx.jobs.read(id, exec.agent)
    snapshot = read.snapshot
    if (read.text.length > 0) {
      retainer.push(read.text)
      probe += read.text
      if (probe.includes(pattern)) break
      probe = carryLength === 0 ? '' : probe.slice(-carryLength)
    }
    if (snapshot.status !== 'running' && snapshot.status !== 'stopping') break
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) break
    await ctx.jobs.wait(id, Math.min(pollMs, remaining), exec.agent, exec.signal)
  }
  const retained = retainer.finish()
  return {
    text: retained.text,
    snapshot,
    waitOmittedBytes: omittedBytes(retained.omittedBytes),
  }
}

/**
 * Block until the job settles or the deadline expires, then read the delta once.
 * @param ctx - context carrying the job registry.
 * @param id - the job to read.
 * @param exec - the calling tool execution (owner fence, aborted signal).
 * @param timeoutMs - total wait budget.
 * @returns the output read after the wait.
 */
async function waitAndRead(
  ctx: Context,
  id: JobId,
  exec: ToolExecution,
  timeoutMs: number,
): Promise<JobOutputRead> {
  await ctx.jobs.wait(id, timeoutMs, exec.agent, exec.signal)
  return { ...ctx.jobs.read(id, exec.agent), waitOmittedBytes: 0 }
}

/**
 * Render one read for the model: the caller's line budget keeps the output
 * tail, and each bound that dropped content states how much at the head of the
 * text so nothing is lost without a record.
 * @param read - the output read, including any bytes a pattern wait dropped.
 * @param tailLines - trailing lines to keep, or undefined to keep them all.
 * @returns the model-facing output text.
 */
function boundRead(read: JobOutputRead, tailLines: number | undefined): string {
  const markers: string[] = []
  if (read.waitOmittedBytes > 0) {
    markers.push(`[earlier output omitted: ${read.waitOmittedBytes} bytes]`)
  }
  let text = read.text
  if (tailLines !== undefined) {
    const kept = keepTrailingLines(text, tailLines)
    if (kept.omitted > 0) {
      markers.push(`[earlier output omitted: ${kept.omitted} ${kept.omitted === 1 ? 'line' : 'lines'}]`)
    }
    text = kept.text
  }
  if (text.length > 0) markers.push(text)
  return markers.join('\n')
}

/** Validate the non-empty constraint that ParameterSchemaSpec cannot express. */
function validateJobId(value: string): JobId {
  if (value.length === 0) {
    throw new Error(`invalid job_id: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return JobId(value)
}

/** Pending presentation shared by the three generic job controls. */
function presentTaskCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput !== undefined ? { rawInput } : {} }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  const pollInterval = config.patternPollIntervalMs ?? 250
  const delivery = config.completionDelivery ?? 'wakeup'
  const wakeBudget = config.maxConsecutiveWakes ?? 3

  // Turns this plugin opened on each owner since that owner last consumed
  // human input. Keyed by the exact Agent, so a same-session replacement
  // starts with a full budget.
  const spentWakes = new WeakMap<Agent, number>()
  if (waitDefault > waitCap) {
    throw new Error(`tool-jobs: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)
  }
  // The cadence is a delay the wait loop hands to `ctx.jobs.wait`, which rejects
  // a non-positive or fractional timeout.
  if (!Number.isSafeInteger(pollInterval) || pollInterval < 1) {
    throw new Error(`tool-jobs: patternPollIntervalMs (${pollInterval}) must be a positive whole number of milliseconds`)
  }
  // A budget is a count of turns. `Infinity` would leave the runaway chain this
  // field exists to bound unbounded, and a fraction never names a turn at all.
  if (!Number.isSafeInteger(wakeBudget)) {
    throw new Error(`tool-jobs: maxConsecutiveWakes (${wakeBudget}) must be a whole number of turns`)
  }
  // Nothing spends the budget under quiet delivery, so nothing needs to refill it.
  if (delivery === 'wakeup') {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      // Claiming is the point the human's input actually enters a step; a notice
      // this plugin itself queued must not refill the budget it just spent.
      if (message.source.kind === 'user') spentWakes.delete(agent)
    })
  }

  const outputLimits = new WeakMap<ToolExecution, number>()
  ctx.on('tools/pre-execute', (exec, next) => {
    const maxBytes = visibleOutputLimit(ctx, exec)
    if (maxBytes !== undefined) outputLimits.set(exec, maxBytes)
    return next()
  }, { prepend: true })
  const finalizeTaskContent: NonNullable<ToolDefinition['finalizeContent']> = (exec, result) => {
    const maxBytes = outputLimits.get(exec) ?? visibleOutputLimit(ctx, exec)
    outputLimits.delete(exec)
    if (maxBytes === undefined) return undefined
    if (exec.name === 'job_output' && !result.isError) {
      // This definition owns and schema-validates the canonical value. Preserve
      // its output/status split only while policy left the default rendering intact.
      const value = result.value as unknown as { text: string; job: PublicJobSnapshot }
      const body = value.text.length > 0 ? value.text : '(no new output)'
      const content = body.endsWith('\n') ? body.slice(0, -1) : body
      const suffix = `\n${statusLine(value.job)}`
      if (rawSingleText(result.content) === `${content}${suffix}`) {
        return [{
          type: 'text',
          text: fitWithSuffix(content, suffix, maxBytes, '\n[output truncated]'),
        }]
      }
    }
    return boundSingleText(result.content, maxBytes)
  }

  // Producers may start work only while a controller is attached.
  ctx.jobs.attachController('tool-jobs')

  // Cross-call guidance follows the filesystem sections and precedes product sections.
  ctx.systemPrompt.section({
    name: 'tool:jobs',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\'s work. When you are blocked on a specific line a job will print, wait for it with job_output(wait: true, pattern: "...") instead of sleeping and re-reading. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.',
  })

  // Use the exact lifecycle owner; reusable ids could resolve to a replacement.
  // A busy owner is injected: the notice waits in its next-step inbox, which
  // the turn cannot close over, so jobs settling together cost one step. An
  // idle owner is woken instead, because an unclaimed notice is a completion
  // the model never learns about. Either way, disposal before the claim
  // discards it with the owner, and teardown settlements arrive `reported`.
  //
  // The registry routes each settlement to the listeners its owner's scope
  // chain reaches, so a mount under one preset never sees another preset's
  // agents; this listener owns delivery, not the choice of whom to deliver to.
  ctx.jobs.onJobDone((snapshot, owner) => {
    if (snapshot.reported || owner === undefined) return
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: fitCompletionNotice(snapshot),
      }],
      source: {
        kind: 'plugin',
        plugin: 'tool-jobs',
        form: 'notice',
        summary: completionSummary(snapshot),
      },
    })
    const spent = spentWakes.get(owner) ?? 0
    if (delivery === 'wakeup' && owner.status === 'idle' && spent < wakeBudget) {
      spentWakes.set(owner, spent + 1)
      owner.followup(message)
      return
    }
    owner.inject(message)
  })

  ctx.tools.register(defineTool({
    name: 'job_output',
    description: 'Read a background job. Stream jobs return only output since the previous read; '
      + 'final-output jobs return their result after settlement. Every response ends with '
      + '`[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap '
      + 'and returns early once `pattern` appears in the output. `tail_lines` and `max_bytes` bound what is returned.',
    // A timed-out wait returns job state rather than a TOOL_TIMEOUT error, so
    // this tool owns its deadline instead of using ToolDefinition.timeoutMs.
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      wait: { type: 'boolean', description: 'Block until the job reaches a terminal status, the timeout expires, or a supplied `pattern` appears. A timed-out wait returns [status: running] and leaves the job alive.' },
      timeout_ms: { type: 'number', description: 'Max wait in milliseconds (only meaningful with wait: true). Defaults to the configured wait timeout; capped by the configured maximum.' },
      pattern: { type: 'string', description: 'Literal text to wait for (only meaningful with wait: true). The wait ends at the first read whose output contains it — before the job itself ends — and returns the output read so far, including that text.' },
      tail_lines: { type: 'number', description: 'Return only the last N lines of the output. Earlier lines were already read and are not returned by a later call.' },
      max_bytes: { type: 'number', description: 'Cap on the complete returned result in UTF-8 bytes, including the [status: ...] line. The tighter of this and the job\'s own output cap applies.' },
    },
    finalizeContent: finalizeTaskContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          job: { ...PUBLIC_TASK_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const body = value.text.length > 0 ? value.text : '(no new output)'
        const separator = body.endsWith('\n') ? '' : '\n'
        return [{ type: 'text', text: `${body}${separator}${statusLine(value.job)}` }]
      },
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      const pattern = args.pattern
      if (pattern !== undefined && (typeof pattern !== 'string' || pattern.length === 0)) {
        throw new Error(`invalid pattern: expected a non-empty string, got ${JSON.stringify(pattern)}`)
      }
      if (pattern !== undefined && args.wait !== true) {
        throw new Error('invalid pattern: waiting for a pattern requires wait: true')
      }
      const tailLines = args.tail_lines === undefined ? undefined : requirePositiveInteger(args.tail_lines, 'tail_lines')
      // Validated here for the caller; `max_bytes` bound the result through
      // `visibleOutputLimit` before this body ran.
      if (args.max_bytes !== undefined) requirePositiveInteger(args.max_bytes, 'max_bytes')
      let read: JobOutputRead
      if (args.wait === true) {
        const timeout = Math.min(args.timeout_ms ?? waitDefault, waitCap)
        read = pattern === undefined
          ? await waitAndRead(ctx, id, exec, timeout)
          : await waitForPattern(
            ctx,
            id,
            exec,
            pattern,
            timeout,
            pollInterval,
            // Retaining more than this call could deliver would only cost memory.
            visibleOutputLimit(ctx, exec) ?? MAX_WAIT_RETENTION_BYTES,
          )
      } else {
        read = { ...ctx.jobs.read(id, exec.agent), waitOmittedBytes: 0 }
      }
      return { text: boundRead(read, tailLines), job: publicJob(read.snapshot) }
    },
    presentCall: args => presentTaskCall(`Read output from background job ${args.job_id}`, 'read', args.job_id),
  }))

  ctx.tools.register(defineTool({
    name: 'job_list',
    description: 'List your background jobs (running and finished) with their ids, kinds, and statuses.',
    parameters: {},
    output: {
      schema: { type: 'array', items: PUBLIC_TASK_SCHEMA },
      render: (_args, jobs) => [{
        type: 'text',
        text: jobs.length === 0
          ? '(no background jobs)'
          : jobs.map(t => `${t.id} [${t.kind}] ${t.status} — ${t.label}`).join('\n'),
      }],
    },
    execute(_args, exec) {
      const jobs = ctx.jobs.list(exec.agent)
      return Promise.resolve(jobs.map(publicJob))
    },
    presentCall: () => presentTaskCall('List background jobs', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'job_kill',
    description: 'Request cancellation of a running background job by job id. Returns immediately; the job settles as killed once its work actually stops.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      reason: { type: 'string', description: 'Optional short reason, recorded in the log and forwarded to the job.' },
    },
    finalizeContent: finalizeTaskContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: {
            type: 'string',
            required: true,
            enum: ['cancellation-requested', 'already-finished'],
          },
          job: { ...PUBLIC_TASK_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'already-finished'
          ? `job ${value.job.id} had already finished ${statusLine(value.job)}`
          : `requested cancellation of job ${value.job.id}`,
      }],
    },
    execute(args, exec) {
      const id = validateJobId(args.job_id)
      const result = ctx.jobs.kill(id, exec.agent, args.reason)
      // A snapshot describes current state without consuming pending output.
      const snapshot = publicJob(ctx.jobs.get(id, exec.agent))
      return Promise.resolve({
        outcome: result === 'already-finished' ? 'already-finished' as const : 'cancellation-requested' as const,
        job: snapshot,
      })
    },
    presentCall: args => presentTaskCall(`Kill background job ${args.job_id}`, 'execute', args.job_id),
  }))
}
