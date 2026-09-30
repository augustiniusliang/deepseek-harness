import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService, { setExtraWritableRoots } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceFiles from '../src/index.ts'

const CAPS = {
  maxBytes: 1024,
  maxFileBytes: 1024,
  maxLines: 100,
  maxEntries: 100,
}

function header(id: SessionId, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    origin: 'subagent',
    ...cwd === undefined ? {} : { cwd },
  }
}

describe('Workspace Files Session scope lookup', () => {
  it('uses live or stored headers without an Agent and leaves with its plugin', async () => {
    const liveId = SessionId('live-subagent')
    const coldId = SessionId('cold-subagent')
    const fallbackId = SessionId('cold-without-cwd')
    const missingId = SessionId('missing')
    const liveRoot = resolve('live-workspace')
    const coldRoot = resolve('cold-workspace')
    const fallbackRoot = resolve('fallback-workspace')
    const stat = vi.fn(async (id: SessionId) => {
      if (id === coldId) return { header: header(coldId, coldRoot) }
      if (id === fallbackId) return { header: header(fallbackId) }
      return undefined
    })
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: fallbackRoot } as never)
    ctx.provide('sessionPersistence', { stat } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)

    try {
      ctx.sessions.create(liveId, { meta: { cwd: liveRoot, origin: 'subagent' } })
      expect(ctx.get('agents')).toBeUndefined()
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      expect(lookup).toMatchObject({
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      })
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')

      await expect(lookup.resolve(liveId)).resolves.toEqual({ sessionId: liveId, roots: [liveRoot] })
      expect(stat).not.toHaveBeenCalled()
      await expect(lookup.resolve(coldId)).resolves.toEqual({ sessionId: coldId, roots: [coldRoot] })
      await expect(lookup.resolve(fallbackId)).resolves.toEqual({ sessionId: fallbackId, roots: [fallbackRoot] })
      await expect(lookup.resolve(missingId)).resolves.toBeUndefined()
      expect(stat.mock.calls.map(([id]) => id)).toEqual([coldId, fallbackId, missingId])

      await workspaceFiles.dispose()
      expect(ctx.typert.lookups.get('workspaceFileScope')).toBeUndefined()
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })

  it('appends a live Session\'s folded extra roots after its header root', async () => {
    const sessionId = SessionId('live-multi-root')
    const primary = resolve('multi-primary')
    const extra = resolve('multi-extra')
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    const sessions = await ctx.plugin(SessionStore)
    const projections = await ctx.plugin(SessionProjectionRegistry)
    const policy = await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: resolve('fallback') })
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)
    try {
      const session = ctx.sessions.create(sessionId, { meta: { cwd: primary, origin: 'subagent' } })
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')
      await expect(lookup.resolve(sessionId)).resolves.toEqual({ sessionId, roots: [primary] })
      setExtraWritableRoots(session, [extra])
      await expect(lookup.resolve(sessionId)).resolves.toEqual({ sessionId, roots: [primary, extra] })
      setExtraWritableRoots(session, [])
      await expect(lookup.resolve(sessionId)).resolves.toEqual({ sessionId, roots: [primary] })
    } finally {
      await workspaceFiles.dispose()
      await typert.dispose()
      await policy.dispose()
      await projections.dispose()
      await sessions.dispose()
    }
  })
})
