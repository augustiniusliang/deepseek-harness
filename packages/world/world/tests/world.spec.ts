/**
 * Tests for the execution-world registry: the WorldRef grammar, backend
 * routing priority (path claim > cwd detection > local fallback), cwd
 * detection, the `world` projection (cwd-detected init + session/world fold),
 * and the local backend's lazy wrap of the mounted fs/subprocess providers.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import WorldRegistry, { formatWorldRef, isWorldRef, parseWorldRef, setSessionWorld } from '@deepseek-ai/dsh-world'
import type { WorldBackend, WorldRef } from '@deepseek-ai/dsh-world'

/** A throwing fs stub; world tests only need provider identity, never I/O. */
class FakeFs extends FileSystem {
  override async resolve(): Promise<FsTarget> { throw new Error('fixture: no I/O') }
  override processPath(): string { throw new Error('fixture: no I/O') }
  override fileUrl(): string { throw new Error('fixture: no I/O') }
  override contains(): boolean { throw new Error('fixture: no I/O') }
  override stat(): Promise<never> { throw new Error('fixture: no I/O') }
  override lstat(): Promise<never> { throw new Error('fixture: no I/O') }
  override readText(): Promise<string> { throw new Error('fixture: no I/O') }
  override streamText(): Promise<AsyncIterable<string>> { throw new Error('fixture: no I/O') }
  override readBytes(): Promise<Uint8Array> { throw new Error('fixture: no I/O') }
  override readByteRange(): Promise<Uint8Array> { throw new Error('fixture: no I/O') }
  override listDir(): Promise<never> { throw new Error('fixture: no I/O') }
  override writeText(): Promise<never> { throw new Error('fixture: no I/O') }
  override editText(): Promise<never> { throw new Error('fixture: no I/O') }
}

/** A throwing subprocess stub; world tests only need provider identity. */
class FakeSubprocess extends SubprocessRuntime {
  override resolveExecutable(): Promise<string> { throw new Error('fixture: no I/O') }
  override terminalEnvironment(): Promise<never> { throw new Error('fixture: no I/O') }
  override spawn(_spec: SubprocessSpawnSpec): SubprocessHandle { throw new Error('fixture: no I/O') }
  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> { throw new Error('fixture: no I/O') }
}

/** One fake remote backend: claims paths and detects cwds under one prefix. */
function remoteBackend(ref: WorldRef, prefix: string, displayName = ref): WorldBackend {
  return {
    ref,
    displayName,
    ownsPath: path => path.startsWith(prefix),
    detectFromCwd: cwd => (cwd.startsWith(prefix) ? ref : null),
    // Identity-only fixtures: no test routes a call through them.
    fs: Object.create(FileSystem.prototype) as FileSystem,
    subprocess: Object.create(SubprocessRuntime.prototype) as SubprocessRuntime,
  }
}

async function mounted() {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(WorldRegistry)
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

/**
 * A minimal Session whose cwd fails the host's own absolute-path grammar — a
 * real `Session.create` rejects such a cwd, which is exactly the host-grammar
 * coupling the world path claim exists to bypass. `resolve()` reads only
 * identity, header, seq, and the log.
 */
function stubSession(id: string, cwd: string): Session {
  return Object.assign({} as Session, {
    id: SessionId(id),
    seq: SessionLogOffset(0),
    inheritedEventCount: SessionLogOffset(0),
    header: {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: 0,
      isSeeded: false,
      cwd,
    },
    snapshotEvents: (): SessionEvent[] => [],
  })
}

describe('WorldRef', () => {
  it.each([
    ['local', { kind: 'local' }],
    ['wsl:Ubuntu', { kind: 'wsl', distro: 'Ubuntu' }],
    ['wsl:Ubuntu:root', { kind: 'wsl', distro: 'Ubuntu', user: 'root' }],
    ['ssh:prod-box', { kind: 'ssh', profileId: 'prod-box' }],
  ] as const)('parses and formats %s as a round trip', (ref, parsed) => {
    expect(parseWorldRef(ref)).toEqual(parsed)
    expect(isWorldRef(ref)).toBe(true)
    expect(formatWorldRef(parsed)).toBe(ref)
  })

  it.each(['', 'LOCAL', 'wsl:', 'wsl::root', 'wsl:a:b:c', 'ssh:', 'ssh:a:b', 'local:extra', 'nope'])(
    'rejects %j',
    (ref) => {
      expect(isWorldRef(ref)).toBe(false)
      expect(() => parseWorldRef(ref)).toThrow(`invalid world reference: ${JSON.stringify(ref)}`)
    },
  )
})

describe('WorldRegistry', () => {
  it('falls back to the local world without any backend', async () => {
    const ctx = await mounted()
    const local = ctx.worlds.resolve({ path: '/anywhere', cwd: '/anywhere' })
    expect(local.ref).toBe('local')
    expect(local.displayName).toBe('Local')
    expect(local.ownsPath('/anywhere')).toBe(false)
    expect(local.detectFromCwd('/anywhere')).toBeNull()
    expect(ctx.worlds.detectWorldForCwd('/anywhere')).toBe('local')
    expect(ctx.worlds.detectWorldForCwd()).toBe('local')
  })

  it('routes a claimed path before cwd detection, and detects cwd otherwise', async () => {
    const ctx = await mounted()
    const wsl = remoteBackend('wsl:Ubuntu', '/home/')
    const ssh = remoteBackend('ssh:prod', '/srv/')
    ctx.worlds.register(wsl)
    ctx.worlds.register(ssh)

    expect(ctx.worlds.resolve({ path: '/srv/app', cwd: '/home/u' })).toBe(ssh)
    expect(ctx.worlds.resolve({ cwd: '/home/u' })).toBe(wsl)
    expect(ctx.worlds.resolve({ path: '/elsewhere', cwd: '/home/u' })).toBe(wsl)
    expect(ctx.worlds.resolve({ path: '/elsewhere' }).ref).toBe('local')
    expect(ctx.worlds.detectWorldForCwd('/srv/app')).toBe('ssh:prod')
    expect(ctx.worlds.detectWorldForCwd('/elsewhere')).toBe('local')
  })

  it('honors registration order as routing priority and disposes registrations', async () => {
    const ctx = await mounted()
    const first = remoteBackend('wsl:First', '/home/')
    const second = remoteBackend('wsl:Second', '/home/')
    const disposeFirst = ctx.worlds.register(first)
    ctx.worlds.register(second)

    expect(ctx.worlds.resolve({ path: '/home/u' })).toBe(first)
    disposeFirst()
    expect(ctx.worlds.resolve({ path: '/home/u' })).toBe(second)
    disposeFirst()
    expect(ctx.worlds.resolve({ path: '/home/u' })).toBe(second)
  })

  it('rejects re-registering the built-in local reference', async () => {
    const ctx = await mounted()
    expect(() => ctx.worlds.register(remoteBackend('local', '/'))).toThrow(
      'worlds: the local backend is built in and cannot be re-registered',
    )
  })

  it('lists registered worlds with local last', async () => {
    const ctx = await mounted()
    ctx.worlds.register(remoteBackend('wsl:Ubuntu', '/home/', 'Ubuntu (WSL)'))
    expect(ctx.worlds.list()).toEqual([
      { ref: 'wsl:Ubuntu', displayName: 'Ubuntu (WSL)' },
      { ref: 'local', displayName: 'Local' },
    ])
  })

  it('looks up backends by reference, local included', async () => {
    const ctx = await mounted()
    const wsl = remoteBackend('wsl:Ubuntu', '/home/')
    ctx.worlds.register(wsl)
    expect(ctx.worlds.backendOf('wsl:Ubuntu')).toBe(wsl)
    expect(ctx.worlds.backendOf('local')?.ref).toBe('local')
    expect(ctx.worlds.backendOf('ssh:nowhere')).toBeUndefined()
  })

  it('wraps the mounted fs and subprocess providers in the local backend', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(FakeFs)
    await ctx.plugin(FakeSubprocess)
    await ctx.plugin(WorldRegistry)

    // The Fake fixtures throw their marker on any call; reaching that throw
    // proves the local backend hands out the mounted providers.
    const local = ctx.worlds.resolve()
    await expect(local.fs.resolve('anything')).rejects.toThrow('fixture: no I/O')
    expect(() => local.subprocess.spawn({} as SubprocessSpawnSpec)).toThrow('fixture: no I/O')
  })

  it('fails loud when the local world has no mounted providers', async () => {
    const ctx = await mounted()
    const local = ctx.worlds.resolve()
    expect(() => local.fs).toThrow('worlds: the local world requires a mounted fs provider')
    expect(() => local.subprocess).toThrow('worlds: the local world requires a mounted subprocess provider')
  })
})

describe('world projection', () => {
  it('initializes from the creation cwd and folds session/world events by replacement', async () => {
    const ctx = await mounted()
    ctx.worlds.register(remoteBackend('wsl:Ubuntu', '/home/'))

    const local = session('sess-local', 'C:\\work')
    expect(ctx.sessionProjections.stateOf(local, 'world')).toBe('local')

    const remote = session('sess-remote', '/home/u/project')
    expect(ctx.sessionProjections.stateOf(remote, 'world')).toBe('wsl:Ubuntu')

    setSessionWorld(remote, 'ssh:prod')
    expect(ctx.sessionProjections.stateOf(remote, 'world')).toBe('ssh:prod')
    setSessionWorld(remote, 'local')
    expect(ctx.sessionProjections.stateOf(remote, 'world')).toBe('local')
    expect(ctx.sessionProjections.stateOf(local, 'world')).toBe('local')
    expect(ctx.sessionProjections.snapshot(remote).values.world).toBe('local')
  })
})

describe('sandbox-policy path claim', () => {
  // The fixture spelling `wslhome/...` is non-absolute on every host, so the
  // host absolute check rejects it until a world claims it.
  async function mountedWithPolicy() {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
    await ctx.plugin(WorldRegistry)
    return ctx
  }

  it('lets a world-claimed workspace root skip host absolute validation', async () => {
    const ctx = await mountedWithPolicy()
    const remote = stubSession('sess-claimed', 'wslhome/u/project')
    expect(() => ctx.sandboxPolicy.resolve({ session: remote })).toThrow(
      'sandbox-policy: workspace root must be an absolute execution-world path',
    )

    ctx.worlds.register(remoteBackend('wsl:Ubuntu', 'wslhome/'))
    expect(ctx.sandboxPolicy.resolve({ session: remote })).toEqual({
      mode: 'workspace-write',
      workspaceRoot: 'wslhome/u/project',
      sessionId: 'sess-claimed',
    })
  })

  it('drops the claim when the world plugin unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
    const fiber = await ctx.plugin(WorldRegistry)
    ctx.worlds.register(remoteBackend('wsl:Ubuntu', 'wslhome/'))
    const remote = stubSession('sess-claimed', 'wslhome/u/project')
    expect(ctx.sandboxPolicy.resolve({ session: remote }).workspaceRoot).toBe('wslhome/u/project')

    await fiber.dispose()
    expect(() => ctx.sandboxPolicy.resolve({ session: remote })).toThrow(
      'sandbox-policy: workspace root must be an absolute execution-world path',
    )
  })
})
