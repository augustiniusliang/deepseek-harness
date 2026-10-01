/**
 * Routing-matrix tests for the world facades: a claimed path routes to its
 * world regardless of cwd, an unclaimed host-absolute path stays local under
 * any cwd, relative paths follow the cwd's world, bare calls fall back to
 * local, and `spawnTerminal` honors the session's world projection over the
 * spec cwd.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import WorldRegistry, { setSessionWorld } from '@deepseek-ai/dsh-world'
import type { WorldBackend, WorldRef } from '@deepseek-ai/dsh-world'
import * as WorldRouter from '@deepseek-ai/dsh-world-router'
import type { RouterFileSystem } from '@deepseek-ai/dsh-world-router'

/** A recording fake fs provider; `tag` identifies the world in call logs and return values. */
class FakeFs extends FileSystem {
  readonly calls: string[] = []
  tag = 'unset'

  override async resolve(path: string): Promise<FsTarget> {
    this.calls.push(`resolve:${path}`)
    return { targetKey: FsTargetKey(`${this.tag}:${path}`), displayPath: path }
  }
  override processPath(target: FsTarget): string {
    this.calls.push('processPath')
    return `${this.tag}|${String(target.targetKey)}`
  }
  override processPathFromHostPath(hostPath: string): string | undefined {
    this.calls.push(`processPathFromHostPath:${hostPath}`)
    return `${this.tag}|${hostPath}`
  }
  override fileUrl(target: FsTarget): string {
    this.calls.push('fileUrl')
    return `file://${this.tag}/${String(target.targetKey)}`
  }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    this.calls.push('contains')
    return String(child.targetKey).startsWith(String(parent.targetKey))
  }
  override async stat(): Promise<FsInfo | undefined> {
    this.calls.push('stat')
    return undefined
  }
  override async lstat(path: string): Promise<undefined> {
    this.calls.push(`lstat:${path}`)
    return undefined
  }
  override async readText(): Promise<string> {
    this.calls.push('readText')
    return this.tag
  }
  override async streamText(): Promise<AsyncIterable<string>> {
    this.calls.push('streamText')
    return (async function* () { /* empty fixture stream */ })()
  }
  override async readBytes(): Promise<Uint8Array> {
    this.calls.push('readBytes')
    return new Uint8Array(0)
  }
  override async readByteRange(): Promise<Uint8Array> {
    this.calls.push('readByteRange')
    return new Uint8Array(0)
  }
  override async listDir(): Promise<[]> {
    this.calls.push('listDir')
    return []
  }
  /** The sandbox policy argument of every writeText call, in order. */
  readonly policies: (SandboxExecutionPolicy | undefined)[] = []
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    void target
    void expected
    void signal
    this.calls.push(`writeText:${content}`)
    this.policies.push(sandboxPolicy)
    return { operation: 'create', version: `v:${content}` as FsVersion, before: null, after: content }
  }
  override async editText(): Promise<never> {
    this.calls.push('editText')
    throw new Error('fixture: editText unused')
  }
  override async watch(): Promise<() => Promise<void>> {
    this.calls.push('watch')
    return async () => {}
  }
}

/** A recording fake subprocess provider. */
class FakeSubprocess extends SubprocessRuntime {
  readonly calls: string[] = []
  tag = 'unset'

  override async resolveExecutable(command: string): Promise<string> {
    this.calls.push(`resolveExecutable:${command}`)
    return `${this.tag}|${command}`
  }
  override async terminalEnvironment(): Promise<never> {
    this.calls.push('terminalEnvironment')
    throw new Error('fixture: terminalEnvironment unused')
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.calls.push(`spawn:${spec.cwd}`)
    return Object.create(null) as SubprocessHandle
  }
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.calls.push(`spawnTerminal:${spec.cwd}`)
    return Object.create(null) as SubprocessTerminalHandle
  }
}

/** The recording providers one fake world carries. */
interface FakeWorld {
  backend: WorldBackend
  fs: FakeFs
  subprocess: FakeSubprocess
}

/**
 * A non-local fake world: its providers are prototype instances WITHOUT the
 * Service constructor's registration side effect, so they never claim ctx.fs.
 */
function fakeWorld(ref: WorldRef, claims: readonly string[], detectPrefixes: readonly string[] = claims): FakeWorld {
  const fs = Object.assign(Object.create(FakeFs.prototype) as FakeFs, { calls: [], policies: [], tag: ref })
  const subprocess = Object.assign(Object.create(FakeSubprocess.prototype) as FakeSubprocess, { calls: [], tag: ref })
  return {
    fs,
    subprocess,
    backend: {
      ref,
      displayName: ref,
      ownsPath: path => claims.some(prefix => path.startsWith(prefix)),
      detectFromCwd: cwd => (detectPrefixes.some(prefix => cwd.startsWith(prefix)) ? ref : null),
      fs,
      subprocess,
    },
  }
}

/**
 * Mount the composition layout under test: the real local providers and the
 * worlds registry inside the isolate realm (so the registry's built-in local
 * backend reads THEM, never the facades), the facades at root.
 */
async function mounted(): Promise<{ ctx: Context; local: FakeWorld }> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  const inner = ctx.isolate('fs').isolate('subprocess')
  const localFs = new FakeFs(inner)
  localFs.tag = 'local'
  const localSubprocess = new FakeSubprocess(inner)
  localSubprocess.tag = 'local'
  await inner.plugin(WorldRegistry)
  await ctx.plugin(WorldRouter)
  const local: FakeWorld = {
    fs: localFs,
    subprocess: localSubprocess,
    backend: {
      ref: 'local',
      displayName: 'Local',
      ownsPath: () => false,
      detectFromCwd: () => null,
      fs: localFs,
      subprocess: localSubprocess,
    },
  }
  return { ctx, local }
}

function spawnSpec(cwd: string, env?: Record<string, string>): SubprocessSpawnSpec {
  return { argv: ['pwd'], cwd, env, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100 }
}

function terminalSpec(cwd: string, env?: Record<string, string>): SubprocessTerminalSpawnSpec {
  return { argv: ['sh'], cwd, env, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 100 }
}

describe('RouterFileSystem', () => {
  it('routes a claimed UNC path to its world under a local cwd', async () => {
    const { ctx, local } = await mounted()
    const wsl = fakeWorld('wsl:Ubuntu', ['/home/', '\\\\wsl$\\Ubuntu\\'])
    ctx.worlds.register(wsl.backend)

    const target = await ctx.fs.resolve('\\\\wsl$\\Ubuntu\\home\\u\\file.ts', { cwd: 'C:\\work' })
    expect(wsl.fs.calls).toEqual(['resolve:\\\\wsl$\\Ubuntu\\home\\u\\file.ts'])
    expect(local.fs.calls).toEqual([])
    expect(await ctx.fs.readText(target)).toBe('wsl:Ubuntu')
    expect(ctx.fs.processPath(target)).toBe('wsl:Ubuntu|wsl:Ubuntu:\\\\wsl$\\Ubuntu\\home\\u\\file.ts')
  })

  it('keeps an unclaimed drive-letter path local under a UNC cwd', async () => {
    const { ctx, local } = await mounted()
    const wsl = fakeWorld('wsl:Ubuntu', ['/home/', '\\\\wsl$\\Ubuntu\\'])
    ctx.worlds.register(wsl.backend)

    const target = await ctx.fs.resolve('C:\\work\\file.ts', { cwd: '\\\\wsl$\\Ubuntu\\home\\u' })
    expect(local.fs.calls).toEqual(['resolve:C:\\work\\file.ts'])
    expect(wsl.fs.calls).toEqual([])
    expect(ctx.fs.fileUrl(target)).toBe('file://local/local:C:\\work\\file.ts')
  })

  it('routes relative paths by cwd and bare calls to local', async () => {
    const { ctx, local } = await mounted()
    const wsl = fakeWorld('wsl:Ubuntu', ['/home/', '\\\\wsl$\\Ubuntu\\'])
    ctx.worlds.register(wsl.backend)

    await ctx.fs.resolve('src/index.ts', { cwd: '/home/u/project' })
    expect(wsl.fs.calls).toEqual(['resolve:src/index.ts'])
    await ctx.fs.resolve('src/other.ts')
    expect(local.fs.calls).toEqual(['resolve:src/other.ts'])
    await ctx.fs.lstat('nested', { cwd: '/home/u' })
    expect(wsl.fs.calls).toEqual(['resolve:src/index.ts', 'lstat:nested'])
  })

  it('routes an unclaimed POSIX-rooted path by the cwd world on a Windows host grammar', async () => {
    const { ctx, local } = await mounted()
    const wsl = fakeWorld('wsl:Ubuntu', ['\\\\wsl$\\Ubuntu\\'], ['\\\\wsl$\\Ubuntu\\'])
    ctx.worlds.register(wsl.backend)

    // '/etc/hosts' claims no backend and is not host-absolute on win32, so the
    // UNC cwd's world resolves it. (On POSIX hosts the same call stays local —
    // the assertion splits by platform grammar.)
    const target = await ctx.fs.resolve('/etc/hosts', { cwd: '\\\\wsl$\\Ubuntu\\home\\u' })
    if (process.platform === 'win32') {
      expect(wsl.fs.calls).toEqual(['resolve:/etc/hosts'])
      expect(local.fs.calls).toEqual([])
    } else {
      expect(local.fs.calls).toEqual(['resolve:/etc/hosts'])
      expect(wsl.fs.calls).toEqual([])
    }
    void target
  })

  it('routes target-bearing reads to the resolving backend and unknown targets to local', async () => {
    const { ctx, local } = await mounted()
    const wsl = fakeWorld('wsl:Ubuntu', ['/home/'])
    ctx.worlds.register(wsl.backend)

    const target = await ctx.fs.resolve('/home/u/file.ts')
    await ctx.fs.stat(target)
    await ctx.fs.listDir(target)
    expect(wsl.fs.calls).toEqual(['resolve:/home/u/file.ts', 'stat', 'listDir'])

    // A target the facade never resolved (foreign handle) falls back to local.
    const foreign: FsTarget = { targetKey: FsTargetKey('foreign:x'), displayPath: 'x' }
    await ctx.fs.stat(foreign)
    expect(local.fs.calls).toEqual(['stat'])
  })

  it('passes the per-call sandbox policy through to the owning backend', async () => {
    const { ctx } = await mounted()
    const wsl = fakeWorld('wsl:Ubuntu', ['/home/'])
    ctx.worlds.register(wsl.backend)

    const target = await ctx.fs.resolve('/home/u/file.ts')
    const policy = { mode: 'workspace-write', workspaceRoot: '/home/u' } as const
    await ctx.fs.writeText(target, 'content', undefined, undefined, policy)
    expect(wsl.fs.policies).toEqual([policy])
  })

  it('advertises the local sandbox mode', async () => {
    const { ctx } = await mounted()
    expect((ctx.fs as RouterFileSystem).sandboxMode).toBeUndefined()
  })
})

describe('RouterSubprocessRuntime', () => {
  it('routes spawn by cwd and keeps executable lookup local', async () => {
    const { ctx, local } = await mounted()
    const wsl = fakeWorld('wsl:Ubuntu', ['/home/', '\\\\wsl$\\Ubuntu\\'])
    ctx.worlds.register(wsl.backend)

    ctx.subprocess.spawn(spawnSpec('/home/u/project'))
    expect(wsl.subprocess.calls).toEqual(['spawn:/home/u/project'])
    ctx.subprocess.spawn(spawnSpec('C:\\work'))
    expect(local.subprocess.calls).toEqual(['spawn:C:\\work'])
    await expect(ctx.subprocess.resolveExecutable('node')).resolves.toBe('local|node')
  })

  it('prefers the session world projection over the terminal cwd', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const inner = ctx.isolate('fs').isolate('subprocess')
    const localFs = new FakeFs(inner)
    localFs.tag = 'local'
    const localSubprocess = new FakeSubprocess(inner)
    localSubprocess.tag = 'local'
    await inner.plugin(WorldRegistry)
    await ctx.plugin(WorldRouter)
    const wsl = fakeWorld('wsl:Ubuntu', ['/home/', '\\\\wsl$\\Ubuntu\\'])
    ctx.worlds.register(wsl.backend)

    const sessionId = SessionId('sess-terminal')
    const session: Session = ctx.sessions.create(sessionId, {
      meta: { cwd: '/home/u/project' },
    })
    expect(session.id).toBe(sessionId)
    setSessionWorld(session, 'wsl:Ubuntu')

    // The cwd spells a local path, but the session's world projection pins wsl.
    await ctx.subprocess.spawnTerminal(terminalSpec('C:\\work', { DSH_SESSION_ID: sessionId }))
    expect(wsl.subprocess.calls).toEqual(['spawnTerminal:C:\\work'])
    expect(localSubprocess.calls).toEqual([])

    // spawn honors the same pin (a credential-registered drive workspace keeps
    // its drive-letter cwd while running inside its world).
    ctx.subprocess.spawn(spawnSpec('C:\\work', { DSH_SESSION_ID: sessionId }))
    expect(wsl.subprocess.calls).toEqual(['spawnTerminal:C:\\work', 'spawn:C:\\work'])
    expect(localSubprocess.calls).toEqual([])

    // An unknown session id falls back to the cwd route.
    await ctx.subprocess.spawnTerminal(terminalSpec('C:\\work', { DSH_SESSION_ID: 'sess-unknown' }))
    expect(localSubprocess.calls).toEqual(['spawnTerminal:C:\\work'])

    // No DSH_SESSION_ID routes by cwd alone.
    await ctx.subprocess.spawnTerminal(terminalSpec('/home/u/project'))
    expect(wsl.subprocess.calls).toEqual(['spawnTerminal:C:\\work', 'spawn:C:\\work', 'spawnTerminal:/home/u/project'])
  })

  it('routes terminals by cwd when the projection services are absent', async () => {
    const { ctx, local } = await mounted()
    const wsl = fakeWorld('wsl:Ubuntu', ['/home/'])
    ctx.worlds.register(wsl.backend)

    await ctx.subprocess.spawnTerminal(terminalSpec('C:\\work', { DSH_SESSION_ID: 'sess-anything' }))
    expect(local.subprocess.calls).toEqual(['spawnTerminal:C:\\work'])
    await ctx.subprocess.spawnTerminal(terminalSpec('/home/u'))
    expect(wsl.subprocess.calls).toEqual(['spawnTerminal:/home/u'])
  })
})
