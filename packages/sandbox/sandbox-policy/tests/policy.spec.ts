/**
 * Tests for the sandbox-policy home: the deployment default (mode +
 * workspaceRoot) the service exposes, and the per-session `sandbox/mode`
 * override kit (fold + write path) every enforcing capability reads.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'

async function mounted(config: {
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot?: string
  extraWritableRoots?: string[]
  tempRoot?: string
  workspaceSandbox?: Record<string, { extraWritableRoots?: string[]; tempRoot?: string }>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, config)
  return ctx
}

function session(id: string, cwd?: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    ...cwd === undefined ? {} : { cwd },
  })
}

function agentFor(activeSession: Session): Agent {
  return { session: activeSession } as unknown as Agent
}

async function policyContext(ctx: Context, activeSession: Session): Promise<string | undefined> {
  return (await ctx.systemPrompt.assemble({ agent: agentFor(activeSession) }))
    .contexts.find(context => context.name === 'sandbox:policy')?.text
}

describe('SandboxPolicyService', () => {
  it('defaults to read-only under the process cwd', async () => {
    const ctx = await mounted()
    expect(ctx.sandboxPolicy.defaultMode).toBe('read-only')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe(resolve(process.cwd()))
  })

  it('preserves an absolute execution-world root without host path normalization', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/ws/../ws/./sub' })
    expect(ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
    expect(ctx.sandboxPolicy.workspaceRoot).toBe('/ws/../ws/./sub')
  })

  it('appends configured extra writable roots to every resolved policy', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/projects/current', extraWritableRoots: ['/tasks/main', '/shared/ddc'] })
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/projects/current',
      extraWritableRoots: ['/tasks/main', '/shared/ddc'],
    })
    // A session cwd replaces the PRIMARY root; extras still apply.
    expect(ctx.sandboxPolicy.resolve({ session: session('sess-extras', '/projects/other') })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/projects/other',
      extraWritableRoots: ['/tasks/main', '/shared/ddc'],
      sessionId: SessionId('sess-extras'),
    })
  })

  it('drops nested and duplicate extra roots keeping the widest, with a warning', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/projects/current', extraWritableRoots: ['/tasks', '/tasks/nested', '/tasks', '/shared'] })
    const warnings: string[] = []
    // Intercept the service's warning sink: the reduction is observable ONLY
    // through the dropped-entry warnings (the kept set is the other half).
    ctx.logger.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    const policy = ctx.sandboxPolicy.resolve()
    expect(policy.extraWritableRoots).toEqual(['/tasks', '/shared'])
    expect(warnings.join('\n')).toContain('/tasks/nested')
    expect(warnings.join('\n')).toContain('/tasks')
    // An extra that CONTAINS the workspace root is kept (it is wider than the
    // primary); only extra-vs-extra and exact duplicates reduce.
    const wider = await mounted({ mode: 'workspace-write', workspaceRoot: '/projects/current', extraWritableRoots: ['/projects'] })
    expect(wider.sandboxPolicy.resolve().extraWritableRoots).toEqual(['/projects'])
  })

  it('applies workspace-bound defaults for the matching workspace, deployment values elsewhere', async () => {
    const ctx = await mounted({
      mode: 'workspace-write',
      workspaceRoot: '/fallback',
      extraWritableRoots: ['/deploy/extra'],
      tempRoot: '/deploy/temp',
      workspaceSandbox: {
        '/projects/current': { extraWritableRoots: ['/ws/extra'], tempRoot: '/ws/temp' },
      },
    })
    ctx.logger.warn = () => {}
    // Matching workspace: the entry's fields win field-by-field.
    expect(ctx.sandboxPolicy.resolve({ session: session('sess-bound', '/projects/current') })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/projects/current',
      extraWritableRoots: ['/ws/extra'],
      tempRoot: '/ws/temp',
      sessionId: SessionId('sess-bound'),
    })
    // Unmatched workspace: deployment values apply unchanged.
    expect(ctx.sandboxPolicy.resolve({ session: session('sess-unbound', '/projects/other') })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/projects/other',
      extraWritableRoots: ['/deploy/extra'],
      tempRoot: '/deploy/temp',
      sessionId: SessionId('sess-unbound'),
    })
  })

  it('lets a workspace entry carry only the field it overrides', async () => {
    const ctx = await mounted({
      mode: 'workspace-write',
      workspaceRoot: '/fallback',
      extraWritableRoots: ['/deploy/extra'],
      workspaceSandbox: { '/projects/current': { tempRoot: '/ws/temp' } },
    })
    ctx.logger.warn = () => {}
    const policy = ctx.sandboxPolicy.resolve({ session: session('sess-partial', '/projects/current') })
    expect(policy.tempRoot).toBe('/ws/temp')
    expect(policy.extraWritableRoots).toEqual(['/deploy/extra'])
  })

  it('omits tempRoot from the policy when neither binding configures one', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/projects/current' })
    expect('tempRoot' in ctx.sandboxPolicy.resolve()).toBe(false)
  })

  it('rejects a relative configured tempRoot at load and keeps an absolute one', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await expect(ctx.plugin(SandboxPolicyService, { tempRoot: 'relative/temp' }))
        .rejects.toThrow('sandbox-policy: workspace root must be an absolute execution-world path')
      expect(ctx.get('sandboxPolicy')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
    const ok = await mounted({ tempRoot: '/absolute/temp' })
    expect(ok.sandboxPolicy.tempRoot).toBe('/absolute/temp')
  })

  it('a creation-declared spec REPLACES the root set (narrower than the workspace) and overrides tempRoot', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/projects/current', extraWritableRoots: ['/deploy/extra'], tempRoot: '/deploy/temp' })
    ctx.logger.warn = () => {}
    const bound = session('sess-spec', '/projects/current')
    ctx.sandboxPolicy.setSessionSpec(bound, { writableRoots: ['/projects/current/src', '/tasks/main'], tempRoot: '/sess/temp' }, 'spawn')
    expect(ctx.sandboxPolicy.resolve({ session: bound })).toEqual({
      mode: 'workspace-write',
      // The first declared root takes the place `workspaceRoot` otherwise holds,
      // so the session writes ONLY under the subdirectory + the task root.
      workspaceRoot: '/projects/current/src',
      extraWritableRoots: ['/tasks/main'],
      tempRoot: '/sess/temp',
      sessionId: SessionId('sess-spec'),
    })
  })

  it('seals at creation: a later non-user spec is inert, a user-sourced one supersedes', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/projects/current' })
    const warnings: string[] = []
    ctx.logger.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    const target = session('sess-seal', '/projects/current')
    ctx.sandboxPolicy.setSessionSpec(target, { writableRoots: ['/projects/current'] }, 'spawn')
    // A second spawn-sourced write (a delegated child seeded in, a plugin, a
    // stray script) is recorded but cannot move the boundary.
    ctx.sandboxPolicy.setSessionSpec(target, { writableRoots: ['/'] }, 'spawn')
    expect(ctx.sandboxPolicy.resolve({ session: target }).workspaceRoot).toBe('/projects/current')
    expect(warnings.join('\n')).toContain('only a user-sourced change may supersede it')
    // A human (GUI) change does take effect, in both directions.
    ctx.sandboxPolicy.setSessionSpec(target, { writableRoots: ['/projects/current/src'] }, 'user')
    expect(ctx.sandboxPolicy.resolve({ session: target }).workspaceRoot).toBe('/projects/current/src')
    ctx.sandboxPolicy.setSessionSpec(target, { writableRoots: ['/projects/current', '/tasks/main'] }, 'user')
    const widened = ctx.sandboxPolicy.resolve({ session: target })
    expect(widened.workspaceRoot).toBe('/projects/current')
    expect(widened.extraWritableRoots).toEqual(['/tasks/main'])
  })

  it('a session without a spec keeps the workspace binding and deployment values', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback', extraWritableRoots: ['/deploy/extra'], tempRoot: '/deploy/temp' })
    ctx.logger.warn = () => {}
    const plain = session('sess-plain', '/projects/current')
    expect(ctx.sandboxPolicy.specOf(plain)).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve({ session: plain })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/projects/current',
      extraWritableRoots: ['/deploy/extra'],
      tempRoot: '/deploy/temp',
      sessionId: SessionId('sess-plain'),
    })
  })

  it('rejects an invalid spec before appending anything', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/projects/current' })
    const target = session('sess-invalid', '/projects/current')
    expect(() => { ctx.sandboxPolicy.setSessionSpec(target, { writableRoots: [] }, 'spawn') })
      .toThrow(/invalid session sandbox spec/u)
    expect(() => { ctx.sandboxPolicy.setSessionSpec(target, { writableRoots: ['relative/root'] }, 'spawn') })
      .toThrow(/must be an absolute execution-world path/u)
    expect(() => { ctx.sandboxPolicy.setSessionSpec(target, { tempRoot: 'relative/temp' }, 'spawn') })
      .toThrow(/must be an absolute execution-world path/u)
    // Nothing was sealed by the failed attempts.
    expect(ctx.sandboxPolicy.specOf(target)).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve({ session: target }).workspaceRoot).toBe('/projects/current')
  })

  it('keeps a session spec on the policy under read-only (enforcers ignore it)', async () => {
    const ctx = await mounted({ mode: 'read-only', workspaceRoot: '/projects/current' })
    const target = session('sess-ro', '/projects/current')
    ctx.sandboxPolicy.setSessionSpec(target, { writableRoots: ['/projects/current/src'] }, 'spawn')
    const policy = ctx.sandboxPolicy.resolve({ session: target })
    expect(policy.mode).toBe('read-only')
    expect(policy.workspaceRoot).toBe('/projects/current/src')
  })

  it('omits extraWritableRoots entirely when none are configured', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/projects/current' })
    expect('extraWritableRoots' in ctx.sandboxPolicy.resolve()).toBe(false)
  })

  it('keeps extraWritableRoots on the policy under read-only (enforcers ignore them, the seam fails closed)', async () => {
    const ctx = await mounted({ mode: 'read-only', workspaceRoot: '/projects/current', extraWritableRoots: ['/tasks/main'] })
    // Policy resolution is mode-agnostic about the roots; the enforcing
    // provider decides (read-only grants nothing).
    expect(ctx.sandboxPolicy.resolve().extraWritableRoots).toEqual(['/tasks/main'])
  })

  it('rejects a relative deployment workspace root at load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await expect(ctx.plugin(SandboxPolicyService, { workspaceRoot: 'relative/workspace' }))
        .rejects.toThrow('sandbox-policy: workspace root must be an absolute execution-world path')
      expect(ctx.get('sandboxPolicy')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves the deployment policy for an agentless call', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/fallback',
    })
  })

  it('resolves each session mode and cwd together without changing the fallback', async () => {
    const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })
    const first = session('sess-first', '/projects/first')
    const second = session('sess-second', '/projects/second')
    setSandboxMode(second, 'read-only')

    expect(ctx.sandboxPolicy.resolve({ session: first })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/projects/first',
      sessionId: 'sess-first',
    })
    expect(ctx.sandboxPolicy.resolve({ session: second })).toEqual({
      mode: 'read-only',
      workspaceRoot: '/projects/second',
      sessionId: 'sess-second',
    })
    expect(ctx.sandboxPolicy.overrideOf(first)).toBeUndefined()
    expect(ctx.sandboxPolicy.overrideOf(second)).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve()).toEqual({
      mode: 'workspace-write',
      workspaceRoot: '/fallback',
    })
  })

  it.skipIf(process.platform === 'win32')('preserves symlink-sensitive session cwd for its enforcing provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-policy-cwd-'))
    try {
      const lexical = join(root, 'lexical')
      const physical = join(root, 'physical')
      const child = join(physical, 'child')
      mkdirSync(lexical)
      mkdirSync(child, { recursive: true })
      const link = join(lexical, 'link')
      symlinkSync(child, link, 'dir')
      const cwd = `${link}${sep}..`
      const ctx = await mounted({ mode: 'workspace-write', workspaceRoot: '/fallback' })

      expect(ctx.sandboxPolicy.resolve({ session: session('sess-symlink-parent', cwd) })).toEqual({
        mode: 'workspace-write',
        workspaceRoot: cwd,
        sessionId: 'sess-symlink-parent',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets an approved mode outrank the session mode while retaining its root', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    const active = session('sess-approved', '/projects/approved')
    setSandboxMode(active, 'read-only')
    expect(ctx.sandboxPolicy.resolve({ session: active, mode: 'danger-full-access' })).toEqual({
      mode: 'danger-full-access',
      workspaceRoot: '/projects/approved',
      sessionId: 'sess-approved',
    })
  })

  it('uses the configured root when a session has no cwd', async () => {
    const ctx = await mounted({ workspaceRoot: '/fallback' })
    expect(ctx.sandboxPolicy.resolve({ session: session('sess-no-cwd') }).workspaceRoot).toBe('/fallback')
  })

  it('rejects a mode outside the closed vocabulary at load', async () => {
    const ctx = new Context()
    // Config validation runs when the fiber activates, and the policy seam
    // requires the projection registry (mandatory injection) to activate.
    await ctx.plugin(SessionProjectionRegistry)
    // schemastery rejects the union violation when the plugin loads.
    await expect(ctx.plugin(SandboxPolicyService, { mode: 'yolo' as never })).rejects.toThrow()
  })

  it('disposes the service and context contribution from a child fiber (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(SandboxPolicyService, {})
    expect(ctx.sandboxPolicy).toBeDefined()
    expect(await policyContext(ctx, session('sess-hmr'))).toContain('read-only')
    await fiber.dispose()
    expect(ctx.get('sandboxPolicy')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')).toBeUndefined()
  })
})

describe('sandbox:policy request context', () => {
  async function promptMounted(config: { mode?: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot?: string; extraWritableRoots?: string[] } = {}): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, config)
    return ctx
  }

  it('renders every writable root in the multi-root policy text', async () => {
    const ctx = await promptMounted({
      mode: 'workspace-write',
      workspaceRoot: '/projects/current',
      extraWritableRoots: ['/tasks/main', '/shared/ddc'],
    })
    expect(await policyContext(ctx, session('sess-multi-root', '/projects/current'))).toBe(
      `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspaces: ${JSON.stringify(['/projects/current', '/tasks/main', '/shared/ddc'])}. Some platform temporary areas may also be writable.`,
    )
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('renders the exact %s policy without a capability inventory', async (mode) => {
    const ctx = await promptMounted({ mode, workspaceRoot: '/fallback' })
    const workspaceRoot = '/projects/../projects/current'
    const expected = {
      'read-only': 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.',
      'workspace-write': `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(workspaceRoot)}. Some platform temporary areas may also be writable.`,
      'danger-full-access': 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.',
    } as const

    expect(await policyContext(ctx, session(`sess-${mode}`, '/projects/../projects/current'))).toBe(expected[mode])
  })

  it('keeps the complete rendered prompt byte-stable across TMPDIR changes', async () => {
    const ctx = await promptMounted({ mode: 'workspace-write' })
    const active = session('sess-tmpdir-stability', '/projects/current')
    const previous = process.env.TMPDIR
    try {
      process.env.TMPDIR = '/tmp/first-host-temp'
      const firstAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      const firstPrompt = renderPrompt(firstAssembly)
      const firstContext = renderContextSnapshot(firstAssembly)
      process.env.TMPDIR = '/tmp/second-host-temp'
      const secondAssembly = await ctx.systemPrompt.assemble({ agent: agentFor(active) })
      expect(renderPrompt(secondAssembly)).toBe(firstPrompt)
      expect(renderContextSnapshot(secondAssembly)).toBe(firstContext)
      expect(firstContext).not.toContain('host-temp')
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  it('reflects the latest durable switch on the next assembly and stays byte-stable otherwise', async () => {
    const ctx = await promptMounted()
    const active = session('sess-switch', '/projects/current')
    const first = await policyContext(ctx, active)
    expect(await policyContext(ctx, active)).toBe(first)

    setSandboxMode(active, 'danger-full-access')
    const danger = await policyContext(ctx, active)
    expect(danger).toBe('Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.')
    expect(await policyContext(ctx, active)).toBe(danger)

    setSandboxMode(active, 'workspace-write')
    expect(await policyContext(ctx, active)).toBe(`Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify('/projects/current')}. Some platform temporary areas may also be writable.`)
  })

  it('reconstructs resumed policy from the session log and omits diagnostics without an agent', async () => {
    const active = session('sess-resume', '/projects/current')
    setSandboxMode(active, 'workspace-write')
    const resumed = Session.create(active.id, active.snapshotEvents(), active.header)
    const ctx = await promptMounted({ mode: 'read-only' })

    expect(await policyContext(ctx, resumed)).toContain('workspace-write')
    expect((await ctx.systemPrompt.assemble()).contexts.find(context => context.name === 'sandbox:policy')?.text).toBe('')
  })
})

describe('the sandbox/mode session kit', () => {
  it('SANDBOX_MODES lists every mode for advertisement and validation', () => {
    expect(SANDBOX_MODES).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('the sandboxMode projection folds to the last switch, or null without one', async () => {
    const ctx = await mounted()
    const session = Session.create(SessionId('sess-fold'))
    expect(ctx.sessionProjections.stateOf(session, 'sandboxMode')).toBeNull()
    setSandboxMode(session, 'workspace-write')
    setSandboxMode(session, 'read-only')
    expect(ctx.sessionProjections.stateOf(session, 'sandboxMode')).toBe('read-only')
  })

  it('setSandboxMode appends exactly one sandbox/mode event per switch', () => {
    const session = Session.create(SessionId('sess-write'))
    setSandboxMode(session, 'danger-full-access')
    const modeEvents = session.snapshotEvents().filter(e => e.type === 'sandbox/mode')
    expect(modeEvents).toHaveLength(1)
    expect(modeEvents[0]?.data).toEqual({ mode: 'danger-full-access' })
  })
})
