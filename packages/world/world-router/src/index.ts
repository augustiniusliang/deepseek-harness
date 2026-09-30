/**
 * The world-router facade (`@deepseek-ai/dsh-world-router`): the composition's
 * `ctx.fs` and `ctx.subprocess`, delegating every call to the execution world
 * that owns it. Routing rides the `ctx.worlds` registry: a call carrying an
 * absolute path goes to the backend claiming it, otherwise the call's cwd
 * decides, otherwise the local fallback serves it. The facade publishes no
 * service of its own and holds no policy — sandbox policy, escalation, and
 * fencing stay with each backend verbatim.
 *
 * The composition mounts the real local providers inside an isolate realm
 * together with the `ctx.worlds` registry, so the registry's built-in local
 * backend reads the REAL providers from its own realm while root-level
 * consumers (tools, shell executors, terminals) see only these facades.
 *
 * @module @deepseek-ai/dsh-world-router
 */

import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { LOCAL_WORLD_REF } from '@deepseek-ai/dsh-world'
import type { WorldBackend, WorldRef } from '@deepseek-ai/dsh-world'
import type {} from '@deepseek-ai/dsh-world'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * `ctx.fs` facade. Path-bearing operations (`resolve`, `lstat`,
 * `processPathFromHostPath`) route by path claim, then cwd, then local.
 * Target-bearing operations route to the backend that produced the target at
 * `resolve()` time — a target the facade never resolved falls back to local.
 */
export class RouterFileSystem extends FileSystem {
  static inject = ['worlds']

  /** Target → owning backend, recorded by {@link resolve}; entries die with their targets. */
  private readonly origins = new WeakMap<FsTarget, WorldBackend>()

  /** The default-mode capability fact of the local world — the value tools advertise escalation from. */
  override get sandboxMode(): SandboxMode | undefined {
    return this.ctx.worlds.resolve({}).fs.sandboxMode
  }

  /**
   * Route by path claim, then cwd, then local. An unclaimed path that is
   * absolute in the HOST grammar is a host-local path: it never follows a
   * non-local cwd (a drive-letter path in a UNC-cwd session stays local).
   * Relative paths carry no world identity, so the cwd's world resolves them.
   */
  private route(path?: string, cwd?: string): WorldBackend {
    if (path !== undefined) {
      const claimed = this.ctx.worlds.resolve({ path })
      if (claimed.ref !== LOCAL_WORLD_REF || cwd === undefined || isAbsolute(path)) return claimed
      return this.ctx.worlds.resolve({ cwd })
    }
    return this.ctx.worlds.resolve(cwd === undefined ? {} : { cwd })
  }

  /** Route a resolved target to its producing backend, local when unknown. */
  private routeTarget(target: FsTarget): WorldBackend {
    return this.origins.get(target) ?? this.route()
  }

  override watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    return this.routeTarget(target).fs.watch(target, changed, signal)
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const backend = this.route(path, opts?.cwd)
    const target = await backend.fs.resolve(path, opts)
    this.origins.set(target, backend)
    return target
  }

  override processPath(target: FsTarget): string {
    return this.routeTarget(target).fs.processPath(target)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return this.route(hostPath).fs.processPathFromHostPath(hostPath)
  }

  override fileUrl(target: FsTarget): string {
    return this.routeTarget(target).fs.fileUrl(target)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return this.routeTarget(parent).fs.contains(parent, child)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.routeTarget(target).fs.stat(target, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    return this.route(path, opts?.cwd).fs.lstat(path, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.routeTarget(target).fs.readText(target, signal)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.routeTarget(target).fs.streamText(target, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.routeTarget(target).fs.readBytes(target, signal, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return this.routeTarget(target).fs.readByteRange(target, range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.routeTarget(target).fs.listDir(target, signal)
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.routeTarget(target).fs.writeText(target, content, expected, signal, sandboxPolicy)
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.routeTarget(target).fs.editText(target, edit, expected, signal, sandboxPolicy)
  }
}

/**
 * `ctx.subprocess` facade. `spawn` routes by the spec's cwd. `spawnTerminal`
 * first honors the spec's `DSH_SESSION_ID`: the session's `world` projection
 * pins the world exactly (a session whose world differs from what its cwd
 * spells), and the cwd route serves only when no session or projection value
 * is readable. Executable lookup and terminal-environment inspection are
 * host-local facts and always serve from the local world.
 */
export class RouterSubprocessRuntime extends SubprocessRuntime {
  static inject = ['worlds']

  override resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.ctx.worlds.resolve({}).subprocess.resolveExecutable(command, env, signal)
  }

  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return this.ctx.worlds.resolve({}).subprocess.terminalEnvironment(signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.ctx.worlds.resolve({ cwd: spec.cwd }).subprocess.spawn(spec)
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const sessionId = spec.env?.DSH_SESSION_ID
    const world = sessionId === undefined ? undefined : this.worldOfSession(sessionId)
    const backend = world === undefined
      ? this.ctx.worlds.resolve({ cwd: spec.cwd })
      : this.ctx.worlds.backendOf(world) ?? this.ctx.worlds.resolve({ cwd: spec.cwd })
    return backend.subprocess.spawnTerminal(spec)
  }

  /** The session's projected world, or undefined when the session or its projection is unreadable. */
  private worldOfSession(id: string): WorldRef | undefined {
    const sessions = this.ctx.get('sessions')
    const sessionProjections = this.ctx.get('sessionProjections')
    if (sessions === undefined || sessionProjections === undefined) return undefined
    const session = sessions.get(SessionId(id))
    return session === undefined ? undefined : sessionProjections.stateOf(session, 'world')
  }
}

/** Cordis plugin name. */
export const name = 'world-router'
/** The registry both facades route through. */
export const inject = ['worlds']

/**
 * Mount both facades; the composition keeps the real local providers inside
 * an isolate realm beside the `ctx.worlds` registry.
 * @param ctx - the composition context the facades publish onto.
 */
export function apply(ctx: Context): void {
  ctx.plugin(RouterFileSystem)
  ctx.plugin(RouterSubprocessRuntime)
}
