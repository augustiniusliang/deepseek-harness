/**
 * SSH profile model and discovery: profiles consumed read-only from the
 * `remote-ssh` settings entry (owned by the dsh-remote-ssh plugin, which keeps
 * the management UI and its `remote_ssh_*` tools), plus the `.remote-ssh.json`
 * mirror-root markers that map a local directory to a host workspace.
 *
 * @module @deepseek-ai/dsh-world-ssh/profile
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WorldRef } from '@deepseek-ai/dsh-world'

/** One SSH connection profile, the settings schema the dsh-remote-ssh plugin owns. */
export interface SshProfile {
  id: string
  name: string
  host: string
  port?: number
  user: string
  /** `key`（密钥+BatchMode）或 `password`（sshpass）。 */
  authMethod: string
  keyPath?: string
  password?: string
  /** Remote home root for bare relative paths (default `~`). */
  remoteRoot?: string
  proxyJump?: string
}

/** A `.remote-ssh.json` marker: the local mirror root and its remote workspace. */
export interface MirrorInfo {
  host: string
  user: string
  remotePath: string
  port?: number
  profileId?: string
}

/** One discovered mirror root: the local directory and its marker info. */
export interface MirrorRoot {
  root: string
  info: MirrorInfo
}

/** The settings entry id the dsh-remote-ssh plugin registers its preferences under. */
export const REMOTE_SSH_SETTINGS_NS = 'remote-ssh'

/** The settings entry's value shape this package reads. */
export interface RemoteSshSettingsValue {
  profiles?: SshProfile[]
  workspaces?: { id: string; profileId: string; title: string; remotePath: string; mirrorPath?: string }[]
}

/** One possibly volatile-wrapped settings field: plain array, `{value: [...]}` reference object, or a getter. */
function resolvePrefValue(candidate: unknown): unknown {
  if (Array.isArray(candidate)) return candidate
  if (typeof candidate === 'object' && candidate !== null) {
    if (typeof (candidate as { get?: unknown }).get === 'function') {
      try {
        return (candidate as { get: () => unknown }).get()
      } catch {
        return undefined
      }
    }
    const meta = (candidate as { meta?: { volatile?: unknown } }).meta
    if (meta?.volatile === true && 'value' in candidate) {
      return candidate.value
    }
  }
  return candidate
}

/** Read one array field across the volatile reference shapes (the upstream plugin's prefsArray). */
function prefsArray(...candidates: unknown[]): unknown[] {
  for (const candidate of candidates) {
    const value = resolvePrefValue(candidate)
    if (Array.isArray(value)) return value
  }
  return []
}

/** The subset of the settings service this package reads. */
interface SettingsFace {
  describe(options?: { redactSecrets?: boolean }): { ns?: string; value?: unknown }[]
}

/** The subset of the config editor this package reads (loader entry configs). */
interface ConfigEditorFace {
  entries(): { options: { id?: string; config?: unknown }; fiber?: { config?: unknown } }[]
}

/**
 * Read the configured SSH profiles and workspaces, read-only. Read order mirrors
 * the upstream plugin: `settings.describe()` live value first, then the loader
 * entry's fiber config, then the raw profile-patch row — the settings form only
 * exists once the dsh-remote-ssh fiber is ACTIVE, which races world registration
 * at boot, while the loader row carries the same fields immediately.
 * @param ctx - any context with settings/configEditor services mounted.
 * @returns the configured value (empty fields when nothing is configured).
 */
export function readSshSettings(ctx: Context): RemoteSshSettingsValue {
  const asValue = (candidate: unknown): RemoteSshSettingsValue | undefined =>
    (typeof candidate === 'object' && candidate !== null ? candidate : undefined)
  let described: RemoteSshSettingsValue | undefined
  try {
    const settings = ctx.get('settings') as SettingsFace | undefined
    if (settings !== undefined && typeof settings.describe === 'function') {
      described = asValue(settings.describe().find(d => d.ns === REMOTE_SSH_SETTINGS_NS)?.value)
    }
  } catch {
    described = undefined
  }
  let fiberValue: RemoteSshSettingsValue | undefined
  let rawValue: RemoteSshSettingsValue | undefined
  try {
    const editor = ctx.get('configEditor') as ConfigEditorFace | undefined
    const entry = editor?.entries().find(row => row.options.id === REMOTE_SSH_SETTINGS_NS)
    fiberValue = asValue(entry?.fiber?.config)
    rawValue = asValue(entry?.options.config)
  } catch {
    fiberValue = undefined
    rawValue = undefined
  }
  const profiles = prefsArray(described?.profiles, fiberValue?.profiles, rawValue?.profiles)
  const workspaces = prefsArray(described?.workspaces, fiberValue?.workspaces, rawValue?.workspaces)
  return {
    ...profiles.length > 0 ? { profiles: profiles as SshProfile[] } : {},
    ...workspaces.length > 0 ? { workspaces: workspaces as NonNullable<RemoteSshSettingsValue['workspaces']> } : {},
  }
}

/**
 * 从文件路径向上找最近的「镜像根」（含 `.remote-ssh.json` 的目录）；有界 8 层。
 * @param filePath - the local path to start from.
 * @returns the root and its marker info, or null when no marker exists.
 */
export function findMirrorRoot(filePath: string): MirrorRoot | null {
  if (filePath === '') return null
  let dir = filePath
  for (let i = 0; i < 8 && dir !== ''; i += 1) {
    try {
      const marker = join(dir, '.remote-ssh.json')
      if (existsSync(marker)) {
        const parsed = JSON.parse(readFileSync(marker, 'utf8')) as Partial<MirrorInfo>
        if (typeof parsed.host === 'string' && typeof parsed.user === 'string' && typeof parsed.remotePath === 'string') {
          const info: MirrorInfo = {
            host: parsed.host,
            user: parsed.user,
            remotePath: parsed.remotePath,
            ...parsed.port === undefined ? {} : { port: parsed.port },
            ...parsed.profileId === undefined ? {} : { profileId: parsed.profileId },
          }
          return { root: dir, info }
        }
      }
    } catch {
      // Unreadable or malformed marker: keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Whether a local path sits inside a mirror root (case-insensitive on Windows).
 * @param root - the mirror root directory.
 * @param path - the candidate path.
 * @returns true when the path is the root or below it.
 */
export function pathInside(root: string, path: string): boolean {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const base = norm(root)
  const candidate = norm(path)
  return candidate === base || candidate.startsWith(`${base}\\`)
}

/**
 * The profile a mirror marker refers to: an exact settings match by id, else by
 * host+user, else a synthesized key-auth profile from the marker itself.
 * @param info - the marker info.
 * @param profiles - the configured profiles.
 * @returns the profile to connect with, plus its world identity.
 */
export function profileForMirror(
  info: MirrorInfo,
  profiles: readonly SshProfile[],
): { profile: SshProfile; profileId: string } {
  if (info.profileId !== undefined && info.profileId !== '') {
    const byId = profiles.find(p => p.id === info.profileId)
    if (byId !== undefined) return { profile: byId, profileId: byId.id }
  }
  const byHost = profiles.find(p => p.host === info.host && p.user === info.user)
  if (byHost !== undefined) return { profile: byHost, profileId: byHost.id }
  const synthesized: SshProfile = {
    id: info.profileId ?? `${info.user}@${info.host}`,
    name: `${info.user}@${info.host}`,
    host: info.host,
    user: info.user,
    authMethod: 'key',
    remoteRoot: info.remotePath,
    ...info.port === undefined ? {} : { port: info.port },
  }
  return { profile: synthesized, profileId: synthesized.id }
}

/**
 * The world reference of one SSH profile.
 * @param profileId - the profile's settings id.
 * @returns the `ssh:<profileId>` reference.
 */
export function sshWorldRef(profileId: string): WorldRef {
  return `ssh:${profileId}`
}

/**
 * Identity key for connection reuse: changes to auth facts must not share a session.
 * @param p - the connection profile.
 * @returns the pool key covering every auth-relevant field.
 */
export function profileKey(p: SshProfile): string {
  return `${p.id}|${p.host}:${p.port ?? 22}|${p.user}|${p.authMethod}|${p.keyPath ?? ''}`
}
