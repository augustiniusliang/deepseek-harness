/**
 * The execution-world registry (`ctx.worlds`): the single owner of which
 * execution world a path, cwd, or session routes to. A world is one coherent
 * filesystem + subprocess pair (`local`, a WSL distribution, an SSH profile);
 * providers register a {@link WorldBackend}, and consumers resolve a path or
 * cwd to the backend that owns it. Registration order is routing priority; the
 * built-in local backend wraps the composition's mounted `ctx.fs` /
 * `ctx.subprocess` and is the always-present fallback that claims nothing.
 *
 * The package also owns the per-session world record: the log-only
 * `session/world` event and its `world` projection (registered here), whose
 * initial state is detected from the session's creation cwd. A session without
 * the event runs in that detected world.
 *
 * @module @deepseek-ai/dsh-world
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { LOCAL_WORLD_REF, isWorldRef, parseWorldRef } from './ref.ts'
import type { WorldRef } from './types.ts'

export { LOCAL_WORLD_REF, formatWorldRef, isWorldRef, parseWorldRef } from './ref.ts'
export type { ParsedWorldRef } from './ref.ts'
export { setSessionWorld } from './session-world.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    worlds: WorldRegistry
  }
}

/**
 * One execution world the registry can route to: a plain provider object (NOT
 * a cordis service) pairing the world's filesystem with its subprocess
 * runtime. `ownsPath` and `detectFromCwd` are the routing facts; both must be
 * cheap and synchronous, and a backend claims only paths it can actually serve
 * — an unclaimed path falls through to the next backend and finally to local.
 */
export interface WorldBackend {
  /** The world's encoded reference. */
  ref: WorldRef
  /** Human-readable name for UI lists. */
  displayName: string
  /**
   * Whether an absolute path (in any spelling) belongs to this world.
   * @param absPath - the absolute path to test.
   * @returns true when this world owns the path.
   */
  ownsPath(absPath: string): boolean
  /**
   * Detect whether a session cwd selects this world.
   * @param cwd - the session's creation cwd.
   * @returns this world's reference when the cwd belongs to it, null otherwise.
   */
  detectFromCwd(cwd: string): WorldRef | null
  /** The world's filesystem provider. */
  fs: FileSystem
  /** The world's subprocess provider. */
  subprocess: SubprocessRuntime
}

/** The `world` projection's state schema: state equals the wire view (a validated reference). */
const worldStateSchema: zod.ZodType<WorldRef> = zod.string().refine(isWorldRef, {
  message: 'world projection state must be a valid world reference',
})

/**
 * The execution-world registry service (`ctx.worlds`). Owns the backend list
 * (registration order is routing priority, local last and implicit), path/cwd
 * resolution, cwd detection, and the `world` session projection. When the
 * sandbox-policy service is present, the registry also contributes its path
 * ownership as a policy path claim, so a world-owned workspace root (a POSIX
 * WSL path on a Windows host) passes policy resolution without host absolute
 * validation — the owning backend's filesystem enforces its own fencing.
 */
export class WorldRegistry extends Service {
  static inject = ['sessionProjections']

  /** Registered non-local backends, in routing-priority order. */
  private readonly backends: WorldBackend[] = []

  /**
   * The registry's OWN construction context. Service consumers receive a
   * traceable proxy whose `.ctx` rebinds to the consumer's context; the local
   * backend must keep reading the providers from the realm the registry was
   * mounted in (the composition's isolate realm), never from a caller's realm
   * where `fs` may be the routing facade itself.
   */
  private readonly homeCtx: Context

  constructor(ctx: Context) {
    super(ctx, 'worlds')
    this.homeCtx = ctx

    ctx.sessionProjections.register({
      key: 'world',
      stateVersion: 1,
      stateSchema: worldStateSchema,
      init: header => this.detectWorldForCwd(header.cwd),
      apply: (state, event) => (event.type === 'session/world' ? event.data.world : state),
      // State IS the wire value (the reference string), and the fold returns
      // the event's string only on change, so the registry's reference
      // comparison publishes exactly the changes that happened.
      wire: { viewSchema: worldStateSchema, view: state => state },
    })

    // Optional wiring (world depends on sandbox-policy, never the reverse):
    // a world-claimed path skips the policy's host absolute-path validation.
    ctx.inject(['sandboxPolicy'], (scope: Context) => {
      scope.effect(() => scope.sandboxPolicy.registerPathClaim(path => this.claiming(path) !== undefined))
    })
  }

  /**
   * Register one execution-world backend; registration order is routing
   * priority, and disposal removes the backend.
   * @param backend - the backend to register.
   * @returns the registration's disposer.
   */
  register(backend: WorldBackend): () => void {
    if (backend.ref === LOCAL_WORLD_REF) {
      throw new Error('worlds: the local backend is built in and cannot be re-registered')
    }
    this.backends.push(backend)
    return () => {
      const index = this.backends.indexOf(backend)
      if (index >= 0) this.backends.splice(index, 1)
    }
  }

  /**
   * Resolve one path or cwd to its owning backend. A path a backend claims
   * outranks cwd detection; an unclaimed input falls back to the local world.
   * @param opts - the path and/or cwd to route.
   * @returns the owning backend, or the local fallback.
   */
  resolve(opts: { path?: string; cwd?: string } = {}): WorldBackend {
    if (opts.path !== undefined) {
      const claimed = this.claiming(opts.path)
      if (claimed !== undefined) return claimed
    }
    if (opts.cwd !== undefined) {
      for (const backend of this.backends) {
        if (backend.detectFromCwd(opts.cwd) !== null) return backend
      }
    }
    return this.local()
  }

  /**
   * Detect the world a session cwd belongs to.
   * @param cwd - the session's creation cwd; undefined detects nothing.
   * @returns the first detecting backend's reference, or `'local'`.
   */
  detectWorldForCwd(cwd?: string): WorldRef {
    if (cwd !== undefined) {
      for (const backend of this.backends) {
        const ref = backend.detectFromCwd(cwd)
        if (ref !== null) return ref
      }
    }
    return LOCAL_WORLD_REF
  }

  /**
   * List every registered world plus the local fallback, in routing order.
   * @returns one entry per world, for UI display and remote export.
   */
  list(): { ref: WorldRef; displayName: string }[] {
    return [...this.backends, this.local()].map(backend => ({ ref: backend.ref, displayName: backend.displayName }))
  }

  /**
   * Look up one world by reference, local included. A user-qualified WSL
   * reference (`wsl:<distro>:<user>`) resolves to its distribution's backend:
   * the user is a per-session preference the backend reads from the workspace
   * credentials, not a separate world.
   * @param ref - the world reference.
   * @returns the backend carrying `ref`, or undefined when no registered world does.
   */
  backendOf(ref: WorldRef): WorldBackend | undefined {
    if (ref === LOCAL_WORLD_REF) return this.local()
    const exact = this.backends.find(backend => backend.ref === ref)
    if (exact !== undefined) return exact
    try {
      const parsed = parseWorldRef(ref)
      if (parsed.kind === 'wsl' && parsed.user !== undefined) {
        return this.backends.find(backend => backend.ref === `wsl:${parsed.distro}`)
      }
    } catch {
      // An unparseable ref simply has no backend.
    }
    return undefined
  }

  /** The first backend claiming a path, or undefined when none does. */
  private claiming(path: string): WorldBackend | undefined {
    return this.backends.find(backend => backend.ownsPath(path))
  }

  /**
   * The built-in local backend: a thin wrapper over the composition's mounted
   * `ctx.fs` / `ctx.subprocess`, resolved lazily so mounting order is free. It
   * claims no path and detects no cwd — it exists only as the fallback.
   */
  private local(): WorldBackend {
    const home = this.homeCtx
    return {
      ref: LOCAL_WORLD_REF,
      displayName: 'Local',
      ownsPath: () => false,
      detectFromCwd: () => null,
      get fs(): FileSystem {
        const fs = home.get('fs')
        if (fs === undefined) throw new Error('worlds: the local world requires a mounted fs provider')
        return fs
      },
      get subprocess(): SubprocessRuntime {
        const subprocess = home.get('subprocess')
        if (subprocess === undefined) throw new Error('worlds: the local world requires a mounted subprocess provider')
        return subprocess
      },
    }
  }
}

export default WorldRegistry
