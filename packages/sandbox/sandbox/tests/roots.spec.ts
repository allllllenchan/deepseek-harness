/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    roots.push(dir)
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writable).toContain(realpathSync.native(ws))
    expect(writable).toContain(canonicalPath('/tmp'))
    expect(writable).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(writable).size).toBe(writable.length)
  })

  it('workspace-write grants declared extra roots too (the fs layer must match the ACL runner)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = mkdtempSync(join(tmpdir(), 'dsh-extra-'))
    roots.push(ws, extra)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws, extraWritableRoots: [extra] })
    expect(writable).toContain(realpathSync.native(ws))
    // Regression: omitting extras here denied every fs-tool write under a root
    // the policy resolver and the pwsh/bash ACL runner had already granted
    // (session-b0ccf1cf: `/sandbox root <dir>` succeeded, write/edit still failed).
    expect(writable).toContain(realpathSync.native(extra))
    expect(new Set(writable).size).toBe(writable.length)
  })

  it('read-only still grants nothing even when extra roots are declared', () => {
    const extra = mkdtempSync(join(tmpdir(), 'dsh-extra-'))
    roots.push(extra)
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd(), extraWritableRoots: [extra] })).toEqual([])
  })
})
