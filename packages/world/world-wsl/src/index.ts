/**
 * The WSL world backend (`@deepseek-ai/dsh-world-wsl`): one `WorldBackend` per
 * installed WSL distribution, registered into the `ctx.worlds` registry. The
 * fs half serves the distribution's filesystem over the 9P share with the
 * host's file policy re-fenced at the resolved real path; the subprocess half
 * runs one-shot calls as `wsl.exe --exec` through the local world and
 * persistent terminals through a relay script behind the local PTY.
 *
 * Graceful degradation is the load-time contract: off Windows, or with no
 * distribution installed, the plugin registers nothing and the composition
 * behaves exactly as if the row were absent.
 *
 * @module @deepseek-ai/dsh-world-wsl
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { WorldBackend, WorldRef } from '@deepseek-ai/dsh-world'
import type {} from '@deepseek-ai/dsh-world'
import { getWindowsWorkspace, getWorkspaceUsername } from './credentials.ts'
import { WslFileSystem } from './fs.ts'
import { isWslUnc, parseWslUnc } from './paths.ts'
import { WslSubprocessRuntime } from './subprocess.ts'
import { registerWslBashTool } from './tools-bash.ts'
import { registerWslSearchTools } from './tools-search.ts'
import { listDistros } from './wsl.ts'

export { WslFileSystem } from './fs.ts'
export type { WslFsConfig } from './fs.ts'
export { WslSubprocessRuntime } from './subprocess.ts'
export type { WslSubprocessConfig, WslSubprocessDeps } from './subprocess.ts'
export * from './paths.ts'
export { decodeWslOutput, defaultDistro, defaultDistroSync, listDistros } from './wsl.ts'
export { resolveLinuxSymlink, resolveLinuxSymlinks } from './links.ts'
export * from './credentials.ts'

/** The host capabilities one WSL world backend consumes. */
export interface WslWorldDeps {
  /**
   * A context in the registry's realm: the backend's fs/subprocess register
   * their service seats into per-backend isolate scopes derived from it, and
   * read root services (sandboxPolicy) through it.
   */
  ctx: Context
  /** The local (host) world's subprocess provider, read lazily. */
  localSubprocess: () => SubprocessRuntime
  /** Absolute path of the built relay script. */
  relayPath: string
  /** The `wsl.exe` executable (default `wsl.exe`). */
  wslPath?: string
  /** In-distro probe for executable lookup (tests substitute a fake); default runs `wsl.exe -d <distro> --exec`. */
  probe?: (args: readonly string[], signal?: AbortSignal) => Promise<string | undefined>
}

/** The distribution (and optional user) one backend answers for. */
export interface WslWorldOptions {
  /** Distribution name as `wsl.exe -l -q` reports it. */
  distro: string
  /** Linux user override; undefined = per-workspace credentials, then the distro default. */
  username?: string
}

/**
 * The world reference of one distribution (and optional user).
 * @param distro - the distribution name.
 * @param username - optional Linux user qualifier.
 * @returns the encoded `wsl:<distro>[:<user>]` reference.
 */
export function wslWorldRef(distro: string, username?: string): WorldRef {
  return username === undefined ? `wsl:${distro}` : `wsl:${distro}:${username}`
}

/**
 * Build one distribution's world backend. Path ownership: any WSL UNC naming
 * this distribution, plus credential-registered Windows-drive workspaces
 * assigned to it. cwd detection mirrors ownership and reports the stored
 * workspace user when one exists.
 * @param deps - host capabilities the backend consumes.
 * @param options - the distribution (and optional user) this backend answers for.
 * @returns the backend, ready for `ctx.worlds.register`.
 */
export function createWslWorldBackend(deps: WslWorldDeps, options: WslWorldOptions): WorldBackend {
  const { distro } = options
  // The backends' Service-base registration side effects land in per-backend
  // isolate scopes: inert seats nobody reads, keeping the realm's real
  // providers untouched.
  const fs = new WslFileSystem(deps.ctx.isolate('fs'), { distro })
  const subprocess = new WslSubprocessRuntime(
    deps.ctx.isolate('subprocess'),
    { distro, ...options.username === undefined ? {} : { username: options.username } },
    {
      local: deps.localSubprocess,
      relayPath: deps.relayPath,
      ...deps.wslPath === undefined ? {} : { wslPath: deps.wslPath },
      ...deps.probe === undefined ? {} : { probe: deps.probe },
    },
  )
  const ref = wslWorldRef(distro)
  return {
    ref,
    displayName: `${distro} (WSL)`,
    ownsPath: (absPath) => {
      const unc = parseWslUnc(absPath)
      if (unc !== null) return unc.distro === distro
      return getWindowsWorkspace(absPath)?.distro === distro
    },
    detectFromCwd: (cwd) => {
      const unc = parseWslUnc(cwd)
      if (unc !== null) {
        if (unc.distro !== distro) return null
        const user = getWorkspaceUsername(cwd)
        return user === undefined ? ref : wslWorldRef(distro, user)
      }
      const entry = getWindowsWorkspace(cwd)
      if (entry?.distro !== distro) return null
      return entry.username === undefined ? ref : wslWorldRef(distro, entry.username)
    },
    fs,
    subprocess,
  }
}

/**
 * The relay script location in both layouts: beside the built package entry
 * (`lib/index.js` → `lib/types/relay.js` from the tsc emit) and one level up
 * from the TypeScript source (`src/index.ts` → `lib/types/relay.js`).
 * @returns the absolute relay path.
 * @throws when no built relay exists (the package was never compiled).
 */
export function resolveRelayPath(): string {
  const candidates = [
    new URL('./types/relay.js', import.meta.url),
    new URL('../lib/types/relay.js', import.meta.url),
  ]
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)
    if (existsSync(path)) return path
  }
  throw new Error('world-wsl: the relay script is missing; build the package first (tsc emits lib/types/relay.js)')
}

/** Cordis plugin name. */
export const name = 'world-wsl'

/**
 * Register every installed distribution's backend into the world registry,
 * and claim WSL paths for the sandbox policy. Off Windows or with no
 * distribution installed, registers nothing (one info line) — the composition
 * must boot identically without WSL.
 * @param ctx - the composition context (the world-local isolate realm).
 */
export function apply(ctx: Context): void {
  if (process.platform !== 'win32') {
    ctx.logger.info('world-wsl: not a Windows host, no WSL worlds registered')
    return
  }
  ctx.inject(['worlds'], (scope) => {
    return (async () => {
      let distros: string[]
      try {
        distros = await listDistros()
      } catch (error) {
        scope.logger.info(`world-wsl: no WSL worlds registered (${error instanceof Error ? error.message : String(error)})`)
        return
      }
      if (distros.length === 0) {
        scope.logger.info('world-wsl: no WSL distribution installed, no WSL worlds registered')
        return
      }
      const localSubprocess = (): SubprocessRuntime => scope.worlds.resolve({}).subprocess
      const relayPath = resolveRelayPath()
      for (const distro of distros) {
        scope.effect(() => scope.worlds.register(createWslWorldBackend(
          { ctx: scope, localSubprocess, relayPath },
          { distro },
        )))
      }
      scope.logger.info(`world-wsl: registered ${distros.length} WSL world(s): ${distros.join(', ')}`)
      scope.inject(['sandboxPolicy'], (policyScope) => {
        policyScope.effect(() => policyScope.sandboxPolicy.registerPathClaim(
          path => isWslUnc(path) || getWindowsWorkspace(path) !== undefined,
        ))
      })
      // The world's model-facing tools: bash/grep/glob, visible only in WSL
      // sessions through the registry's world-affinity filter.
      scope.inject(['tools'], (toolScope) => {
        toolScope.effect(() => {
          registerWslBashTool(toolScope)
          registerWslSearchTools(toolScope)
          return () => {}
        })
      })
    })()
  })
}
