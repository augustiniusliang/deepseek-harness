/**
 * The SSH execution world (`@deepseek-ai/dsh-world-ssh`): one `WorldBackend`
 * per configured SSH profile, registered into the `ctx.worlds` registry.
 * Everything executes ON the remote host — a pooled persistent bash session
 * per profile carries commands and filesystem frames, `ssh -tt` channels carry
 * persistent terminals, and the world's own bash/grep/glob tools answer the
 * model in SSH sessions.
 *
 * Graceful degradation is the load-time contract: without a usable OpenSSH
 * client or any configured profile, the plugin registers nothing (one info
 * line) and the composition behaves exactly as if the row were absent.
 *
 * @module @deepseek-ai/dsh-world-ssh
 */

import { spawnSync } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { WorldBackend } from '@deepseek-ai/dsh-world'
import type {} from '@deepseek-ai/dsh-world'
import { SshFileSystem } from './fs.ts'
import { findMirrorRoot, pathInside, profileForMirror, readSshSettings, sshWorldRef } from './profile.ts'
import type { MirrorRoot, SshProfile } from './profile.ts'
import { SshSessionPool } from './session.ts'
import { sshExecutablePath } from './ssh.ts'
import { SshSubprocessRuntime } from './subprocess.ts'
import { registerSshBashTool } from './tools-bash.ts'
import { registerSshSearchTools } from './tools-search.ts'

export { SshFileSystem } from './fs.ts'
export type { SshFsConfig, SshFsDeps } from './fs.ts'
export { SshSubprocessRuntime } from './subprocess.ts'
export type { SshSubprocessDeps } from './subprocess.ts'
export { CommandSession, SshSessionPool } from './session.ts'
export type { RemoteRun } from './session.ts'
export * from './profile.ts'
export { expandSshPath, shellQuote, shellQuotePath, sshArgv, sshErrorHint, sshExecutablePath, stripPqBanner } from './ssh.ts'

/** The host capabilities one SSH world backend consumes. */
export interface SshWorldDeps {
  /**
   * A context in the registry's realm: the backend's fs/subprocess register
   * their service seats into per-backend isolate scopes derived from it, and
   * read root services (sandboxPolicy) through it.
   */
  ctx: Context
  /** The shared session pool (owned by the plugin, disposed with it). */
  pool: SshSessionPool
  /** The local (host) world's subprocess provider, for `ssh -tt` terminals. */
  localSubprocess: () => SubprocessRuntime
  /** Mirror roots belonging to the profile being built. */
  mirrorRoots: readonly MirrorRoot[]
}

/**
 * Build one profile's world backend. Path ownership: any local path inside
 * one of the profile's mirror roots (settings workspaces or `.remote-ssh.json`
 * markers matched by id or host+user).
 * @param deps - host capabilities the backend consumes.
 * @param profile - the connection profile this backend answers for.
 * @returns the backend, ready for `ctx.worlds.register`.
 */
export function createSshWorldBackend(deps: SshWorldDeps, profile: SshProfile): WorldBackend {
  const ref = sshWorldRef(profile.id)
  const fs = new SshFileSystem(deps.ctx.isolate('fs'), profile, { pool: deps.pool, mirrorRoots: deps.mirrorRoots })
  const subprocess = new SshSubprocessRuntime(
    deps.ctx.isolate('subprocess'),
    profile,
    { pool: deps.pool, local: deps.localSubprocess, mirrorRoots: deps.mirrorRoots },
  )
  const ownsMirror = (path: string): MirrorRoot | undefined => {
    const fromSettings = deps.mirrorRoots.find(mirror => pathInside(mirror.root, path))
    if (fromSettings !== undefined) return fromSettings
    const marked = findMirrorRoot(path)
    if (marked === null) return undefined
    return profileForMirror(marked.info, [profile]).profileId === profile.id ? marked : undefined
  }
  // A session created from a mirror root resolves its cwd through this
  // backend's fs, so the recorded cwd is already in the REMOTE grammar
  // (`/home/...`); detection must claim the workspaces' remotePath space too,
  // the same way the WSL backend claims its distributions' Linux paths.
  const ownsRemote = (path: string): boolean => deps.mirrorRoots.some((mirror) => {
    const root = mirror.info.remotePath.replace(/\/+$/, '')
    return path === root || (root !== '' && path.startsWith(`${root}/`)) || (mirror.info.remotePath === '/' && path.startsWith('/'))
  })
  return {
    ref,
    displayName: `${profile.name} (SSH)`,
    ownsPath: absPath => ownsMirror(absPath) !== undefined || ownsRemote(absPath),
    detectFromCwd: cwd => (ownsMirror(cwd) === undefined && !ownsRemote(cwd) ? null : ref),
    fs,
    subprocess,
  }
}

/** Cordis plugin name. */
export const name = 'world-ssh'

/**
 * Register every configured profile's backend into the world registry, plus
 * the world's bash/grep/glob tools. Without a usable OpenSSH client or any
 * profile, registers nothing (one info line).
 * @param ctx - the composition context (the world-local isolate realm).
 */
export function apply(ctx: Context): void {
  const probe = spawnSync(sshExecutablePath(), ['-V'], { encoding: 'utf8', timeout: 10_000 })
  if (probe.error !== undefined || probe.status !== 0) {
    ctx.logger.info('world-ssh: no usable OpenSSH client, no SSH worlds registered')
    return
  }
  ctx.inject(['worlds'], (scope) => {
    const settings = readSshSettings(scope)
    const profiles = settings.profiles ?? []
    if (profiles.length === 0) {
      scope.logger.info('world-ssh: no SSH profile configured, no SSH worlds registered')
      return
    }
    const pool = new SshSessionPool(scope.worlds.resolve({}).subprocess)
    scope.effect(() => () => {
      pool.dispose()
    })
    const localSubprocess = (): SubprocessRuntime => scope.worlds.resolve({}).subprocess
    for (const profile of profiles) {
      // Mirror roots for this profile: settings workspaces carry mirrorPath
      // (the dsh-remote-ssh plugin owns those entries); ad-hoc `.remote-ssh.json`
      // markers are discovered per path at claim time.
      const mirrorRoots: MirrorRoot[] = (settings.workspaces ?? [])
        .filter(workspace => workspace.profileId === profile.id && workspace.mirrorPath !== undefined && workspace.mirrorPath !== '')
        .map(workspace => ({
          root: workspace.mirrorPath as string,
          info: {
            host: profile.host,
            user: profile.user,
            remotePath: workspace.remotePath,
            profileId: profile.id,
            ...profile.port === undefined ? {} : { port: profile.port },
          },
        }))
      scope.effect(() => scope.worlds.register(createSshWorldBackend(
        { ctx: scope, pool, localSubprocess, mirrorRoots },
        profile,
      )))
    }
    scope.logger.info(`world-ssh: registered ${profiles.length} SSH world(s): ${profiles.map(p => p.id).join(', ')}`)
    scope.inject(['tools'], (toolScope) => {
      toolScope.effect(() => {
        registerSshBashTool(toolScope)
        registerSshSearchTools(toolScope)
        return () => {}
      })
    })
  })
}
