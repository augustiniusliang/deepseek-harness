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

  it('read-only ignores extra writable roots', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd(), extraWritableRoots: ['/elsewhere'] })).toEqual([])
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

  it('an absent or empty extra-root list is exactly the single-root allow-list', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const bare = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writableRoots({ mode: 'workspace-write', workspaceRoot: ws, extraWritableRoots: [] })).toEqual(bare)
  })

  it('workspace-write merges extra writable roots canonically and deduplicates against the standing roots', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = mkdtempSync(join(tmpdir(), 'dsh-extra-'))
    roots.push(ws, extra)
    const writable = writableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      // The duplicate workspace root and the missing path exercise the dedupe
      // and the conservative as-is fallback after canonicalization.
      extraWritableRoots: [extra, ws, '/does/not/exist/anywhere-xyz'],
    })
    expect(writable).toContain(realpathSync.native(extra))
    expect(writable).toContain('/does/not/exist/anywhere-xyz')
    expect(writable.filter(root => root === realpathSync.native(ws))).toHaveLength(1)
    expect(new Set(writable).size).toBe(writable.length)
  })
})
