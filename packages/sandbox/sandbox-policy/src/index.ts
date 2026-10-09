/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path; the fold is the
 * `sandboxMode` session-projection unit registered here, while the event and
 * write path come from `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { isAbsolute, relative, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

export { SANDBOX_MODES, setSandboxMode } from './session-mode.ts'

/** Preserve execution-world spelling; enforcing providers resolve filesystem identity on their host. */
function resolveWorkspaceRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error('sandbox-policy: workspace root must be an absolute execution-world path')
  return path
}

/** Case-insensitive on win32-shaped paths, exact elsewhere — string-level only, no filesystem access. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Whether `root` lexically contains `candidate` (or is the same path), WITHOUT touching the filesystem. */
function lexicallyContains(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * Reduce the configured extra roots against the workspace root and one
 * another: drop exact duplicates and any root lexically contained by another
 * (nesting is NOT an error — the wider root already covers it), warning once
 * per dropped entry. Lexical only: the enforcing backends resolve real
 * filesystem identity.
 */
function reduceExtraRoots(workspaceRoot: string, extras: readonly string[], warn: (message: string) => void): string[] {
  const kept: string[] = []
  for (const raw of extras) {
    const extra = resolveWorkspaceRoot(raw)
    const wider = [workspaceRoot, ...kept].find(root => lexicallyContains(root, extra) || samePath(root, extra))
    if (wider !== undefined) {
      warn(`sandbox-policy: extra writable root ${extra} is covered by ${wider}; dropping it (nested roots keep the widest)`)
      continue
    }
    // A later extra may be WIDER than one already kept — evict the narrower.
    const narrower = kept.findIndex(root => lexicallyContains(extra, root) || samePath(extra, root))
    if (narrower !== -1) {
      warn(`sandbox-policy: extra writable root ${kept[narrower]} is covered by ${extra}; dropping it (nested roots keep the widest)`)
      kept.splice(narrower, 1)
    }
    kept.push(extra)
  }
  return kept
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write': {
      // Single-root renders the historical sentence BYTE-IDENTICALLY (the
      // runtime-context snapshot is logged and replayed byte-stable); only
      // multi-root policies take the plural form.
      if (policy.extraWritableRoots === undefined || policy.extraWritableRoots.length === 0) {
        return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
      }
      const roots = JSON.stringify([policy.workspaceRoot, ...policy.extraWritableRoots])
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspaces: ${roots}. Some platform temporary areas may also be writable.`
    }
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
/** One workspace entry's accepted shape; fields stay optional so absence means "fall through". */
const workspaceSandboxEntrySchema = zod.object({
  extraWritableRoots: zod.array(zod.string()).optional(),
  tempRoot: zod.string().optional(),
})

/** The whole `workspaceSandbox` mapping. */
const workspaceSandboxSchema = zod.record(zod.string(), workspaceSandboxEntrySchema)

/**
 * Sandbox defaults bound to ONE workspace path — the workspace level of the
 * single SandboxSpec model (session-level overrides are a later binding of the
 * same fields). Every field is optional: an omitted field falls through to the
 * deployment-level value, then the built-in default.
 */
export interface WorkspaceSandboxDefaults {
  /** Writable roots for sessions in this workspace (replaces the deployment-level extras when present). */
  extraWritableRoots?: string[]
  /** Private-temp parent for sessions in this workspace (overrides the deployment-level value). */
  tempRoot?: string
}

export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Absolute fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
  /**
   * Additional absolute writable roots for `workspace-write`, appended to the
   * (session or fallback) workspace root for EVERY resolved policy (default:
   * none). Exact duplicates and lexically nested entries are dropped with a
   * warning — the widest root already covers them. Read-only ignores them.
   */
  extraWritableRoots?: string[]
  /**
   * Deployment-level private-temp parent (default: the platform temp dir). Must
   * lie outside every writable root; the enforcing backend fails closed when a
   * resolved root contains it.
   */
  tempRoot?: string
  /**
   * Per-workspace defaults, keyed by the workspace path. A session's resolved
   * workspace root selects its entry (exact path match, case-insensitive on
   * win32-shaped paths); an unmatched workspace uses the deployment values.
   * This is the workspace binding of the SandboxSpec model — the same fields a
   * session-level override will later outrank.
   */
  workspaceSandbox?: Record<string, WorkspaceSandboxDefaults>
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

type SandboxModeState = zod.infer<typeof sandboxModeStateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged sandbox-mode override, or null before one (deployment default applies at resolve time). */
    sandboxMode: SandboxModeState
  }
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
    extraWritableRoots: z.array(z.string()),
    tempRoot: z.string(),
    // Untyped on purpose: schemastery materializes an absent array as `[]`,
    // which would erase "this entry does not configure extras" and silently
    // drop the deployment value. The constructor validates and normalizes it
    // through the zod schema below, which preserves absence.
    workspaceSandbox: z.any(),
  })

  static inject = ['sessionProjections']

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  /** Configured extra writable roots (already absolute; reduced at resolve time against the live workspace root). */
  readonly extraWritableRoots: readonly string[]
  /** Deployment-level private-temp parent, when configured. */
  readonly tempRoot: string | undefined
  /** Per-workspace defaults, keyed as configured (matched at resolve time). */
  readonly workspaceSandbox: Readonly<Record<string, WorkspaceSandboxDefaults>>
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
    this.extraWritableRoots = (config.extraWritableRoots ?? []).map(resolveWorkspaceRoot)
    this.tempRoot = config.tempRoot === undefined ? undefined : resolveWorkspaceRoot(config.tempRoot)
    const parsedWorkspaceSandbox = config.workspaceSandbox === undefined
      ? {}
      : (() => {
        const result = workspaceSandboxSchema.safeParse(config.workspaceSandbox)
        if (!result.success) {
          throw new Error(`sandbox-policy: workspaceSandbox must map workspace paths to { extraWritableRoots?, tempRoot? }: ${result.error.message}`)
        }
        return result.data
      })()
    this.workspaceSandbox = Object.fromEntries(
      Object.entries(parsedWorkspaceSandbox).map(([path, defaults]) => [resolveWorkspaceRoot(path), {
        ...defaults.extraWritableRoots === undefined
          ? {}
          : { extraWritableRoots: defaults.extraWritableRoots.map(resolveWorkspaceRoot) },
        ...defaults.tempRoot === undefined ? {} : { tempRoot: resolveWorkspaceRoot(defaults.tempRoot) },
      }]),
    )

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    const workspaceRoot = resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)
    // Workspace binding first (the SandboxSpec workspace level), then the
    // deployment value: an entry's field wins field-by-field, and an absent
    // entry changes nothing.
    const bound = this.workspaceSandboxOf(workspaceRoot)
    const configuredExtras = bound?.extraWritableRoots ?? this.extraWritableRoots
    const extraWritableRoots = configuredExtras.length === 0
      ? []
      : reduceExtraRoots(workspaceRoot, configuredExtras, (message) => { this.ctx.logger.warn(message) })
    const tempRoot = bound?.tempRoot ?? this.tempRoot
    return {
      mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
      workspaceRoot,
      ...(extraWritableRoots.length === 0 ? {} : { extraWritableRoots }),
      ...tempRoot === undefined ? {} : { tempRoot },
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /**
   * The configured defaults bound to one resolved workspace root, matched by
   * path (case-insensitive on win32-shaped paths). Lexical only — no
   * filesystem access: the enforcing backend canonicalizes, and a workspace
   * reached through a differently-spelled path may therefore miss its entry
   * (the documented cost of keeping policy resolution host-free).
   * @param workspaceRoot - the resolved workspace root.
   * @returns the bound defaults, or `undefined` when the workspace has none.
   */
  private workspaceSandboxOf(workspaceRoot: string): WorkspaceSandboxDefaults | undefined {
    for (const [key, defaults] of Object.entries(this.workspaceSandbox)) {
      if (samePath(key, workspaceRoot)) return defaults
    }
    return undefined
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }
}

export default SandboxPolicyService
