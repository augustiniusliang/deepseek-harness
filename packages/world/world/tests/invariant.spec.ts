/** Tests for the world package's invariant companion: the session/world payload grammar check. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import * as WorldInvariant from '@deepseek-ai/dsh-world/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(WorldInvariant)
  return ctx
}

function worldEvent(world: unknown): SessionEvent {
  return { type: 'session/world', seq: 0, time: 0, data: { world } } as SessionEvent
}

describe('world invariants', () => {
  it.each(['local', 'wsl:Ubuntu', 'wsl:Ubuntu:root', 'ssh:prod-box'])(
    'accepts the durable %s world reference',
    async (world) => {
      const ctx = await setup()
      expect(() => { ctx.emit('session/event', {} as Session, worldEvent(world)) }).not.toThrow()
    },
  )

  it('ignores unrelated event streams', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, {
      type: 'turn/start', seq: 0, time: 0, data: {},
    } as SessionEvent) }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it.each([
    ['host-root', '"host-root"'],
    ['wsl:', '"wsl:"'],
    [42, '42'],
  ])('rejects and attributes a forged world payload %j', async (world, rendered) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, worldEvent(world)) })
      .toThrow(new InvariantError('@deepseek-ai/dsh-world', `session/world carries invalid world reference ${rendered}`))
  })

  it('rejects a forged reference already present on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('session/world', { world: 'host-root' })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(WorldInvariant).then(() => undefined)).rejects.toMatchObject({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-world',
    })
  })
})
