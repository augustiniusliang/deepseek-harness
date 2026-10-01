/** Locale bundles for the session-world header chip, plus the ref-to-label mapping. */

import type { WorldRef } from '@deepseek-ai/dsh-world/types'

/** Locale keys this surface renders. */
export type SessionWorldKey = 'local' | 'hint'

/** English copy. */
export const en: Record<SessionWorldKey, string> = {
  local: 'Local',
  hint: 'Execution world {ref} — decided automatically from the workspace path',
}

/** Chinese copy. */
export const zh: Record<SessionWorldKey, string> = {
  local: '本机',
  hint: '执行世界 {ref}（按工作区路径自动判定）',
}

/**
 * The chip's display text for one world reference: `local` translates, a WSL
 * reference names its distribution, an SSH reference names its profile, and
 * anything else passes through verbatim (forward-compatible with new kinds).
 * @param world - the session's world projection value.
 * @param t - the namespace translate.
 * @returns the short chip text.
 */
export function worldLabel(world: WorldRef, t: (key: SessionWorldKey) => string): string {
  if (world === 'local') return t('local')
  if (world.startsWith('wsl:')) {
    const distro = world.slice('wsl:'.length).split(':')[0]
    return distro === '' ? world : `WSL · ${distro}`
  }
  if (world.startsWith('ssh:')) {
    const profile = world.slice('ssh:'.length)
    return profile === '' ? world : `SSH · ${profile}`
  }
  return world
}
