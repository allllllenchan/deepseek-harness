/**
 * Per-session sandbox SPEC: the session-level binding of the SandboxSpec model,
 * stored the same way the mode override is — as a log-only `sandbox/spec` event
 * on the session it applies to (the `sandbox/mode` precedent: durable, replayed
 * on resume, never in the model transcript, no external config store and no
 * session-header format change).
 *
 * WHO MAY SET IT, AND WHEN (the agreed rule):
 *  - AT CREATION, the creator declares the boundary: a spawned child
 *    (`source: 'spawn'`, the same act as the GUI's "new session" form) or a
 *    human-created session. There is no existing boundary to violate yet, and
 *    the declared value is echoed back to the caller and recorded in the log —
 *    the same visibility contract the spawn tool already applies to
 *    `permission`/`approval`.
 *  - AFTER CREATION, only a human (the GUI's remote path) may change it
 *    (`source: 'user'`). The agent has NO tool and no in-process API for it, so
 *    it cannot reach this write path at all: the boundary is "no object to
 *    call", not "a call that gets refused".
 *
 * The projection in `./index.ts` folds the FIRST event as the baseline and
 * accepts a later event ONLY when its source is `'user'`. A later
 * `source: 'spawn'` event (a delegated child seeded into this session, a
 * plugin, a stray script) is therefore recorded but INERT — it cannot widen or
 * narrow a live session.
 *
 * Session-level values outrank the workspace binding, which outranks the
 * deployment config; `writableRoots` REPLACES the default root set (its first
 * entry becomes the primary root, the rest become the policy's extra roots),
 * so a session can be NARROWER than its workspace.
 *
 * KNOWN BOUNDARY (recorded, not enforced): `source` is a declaration made by
 * the writer, not a proof — a host-side plugin that lies can tag itself
 * `'user'`. Forging the log instead means writing `~/.dsh/sessions/**`, which
 * the file sandbox denies in every confined mode and permits only under
 * `danger-full-access`, where every boundary is off by design.
 *
 * @module dsh-sandbox-policy/session-spec
 */

import { isAbsolute } from 'node:path'
import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's sandbox spec was set — log-only (like `approval/*`; NOT a
     * surface event): durable and replayable, never in the model transcript.
     * The FIRST such event is the baseline; a later one takes effect only when
     * `source: 'user'` (see the module doc).
     */
    'sandbox/spec': {
      spec: SessionSandboxSpec
      /** Who declared this spec: the creator at spawn, or a human through the GUI. */
      source: SessionSpecSource
    }
  }
}

/** Who declared a `sandbox/spec` value. */
export type SessionSpecSource = 'spawn' | 'user'

/**
 * The session-level bindings of the SandboxSpec model. Every field is
 * optional: an omitted field falls through to the workspace binding, then the
 * deployment config, then the built-in default.
 */
export interface SessionSandboxSpec {
  /**
   * The session's complete writable root set — REPLACE semantics, not
   * additive. The first entry is the primary root (it takes the place
   * `workspaceRoot` otherwise holds); the rest are extra roots. A single
   * entry may be a SUBDIRECTORY of the workspace, which is how a session is
   * confined more narrowly than its workspace.
   */
  writableRoots?: string[] | undefined
  /** Private-temp parent for this session; must lie outside every writable root. */
  tempRoot?: string | undefined
}

/** Accepted shape of one `sandbox/spec` payload (absolute execution-world paths, non-empty root list). */
const sessionSandboxSpecSchema = zod.object({
  writableRoots: zod.array(zod.string()).min(1).optional(),
  tempRoot: zod.string().optional(),
}).strict()

/**
 * Validate one session spec and resolve its absolute-path requirement WITHOUT
 * touching the filesystem (an execution-world spelling is carried as given;
 * the enforcing backend canonicalizes).
 * @param value - the untrusted spec payload.
 * @returns the validated spec.
 * @throws when the shape is wrong, a path is relative, or the root list is empty.
 */
export function parseSessionSandboxSpec(value: unknown): SessionSandboxSpec {
  const result = sessionSandboxSpecSchema.safeParse(value)
  if (!result.success) {
    throw new Error(`sandbox-policy: invalid session sandbox spec: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  const absolute = (path: string, field: string): string => {
    if (!isAbsolute(path)) throw new Error(`sandbox-policy: session sandbox ${field} must be an absolute execution-world path: ${path}`)
    return path
  }
  return {
    ...result.data.writableRoots === undefined
      ? {}
      : { writableRoots: result.data.writableRoots.map(path => absolute(path, 'writableRoots')) },
    ...result.data.tempRoot === undefined ? {} : { tempRoot: absolute(result.data.tempRoot, 'tempRoot') },
  }
}

/**
 * THE write path for a session's sandbox spec: append exactly one
 * `sandbox/spec` event tagged with its {@link SessionSpecSource}. Call it at
 * creation (spawn / the GUI's new-session form) or, with `'user'`, from the
 * human's GUI path; the projection treats a later non-user event as inert, so
 * an agent-originated append can never move a live boundary.
 * @param session - the session the spec belongs to.
 * @param spec - the spec (invalid input throws before any append).
 * @param source - who is declaring it: the creator, or a human through the GUI.
 */
export function setSandboxSpec(session: Session, spec: SessionSandboxSpec, source: SessionSpecSource): void {
  // Runtime guard for UNTYPED callers (a plugin or script passing a raw
  // string): a source the fold does not recognize must never reach the log as
  // if it were a declaration.
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- untyped JSON/plugin callers
  if (source !== 'spawn' && source !== 'user') {
    throw new Error(`sandbox-policy: unknown session sandbox spec source: ${String(source)}`)
  }
  session.append('sandbox/spec', { spec: parseSessionSandboxSpec(spec), source })
}
