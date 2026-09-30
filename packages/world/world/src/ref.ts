/**
 * The `WorldRef` grammar: a single string encoding which execution world a
 * session runs in — `'local'`, `'wsl:<distro>'`, `'wsl:<distro>:<user>'`, or
 * `'ssh:<profileId>'`. The string is the durable and wire form (session event
 * payload, projection state, client view); parse it for routing decisions,
 * never for storage.
 *
 * @module @deepseek-ai/dsh-world/ref
 */

import type { WorldRef } from './types.ts'

/** The reference of the host's own execution world — the routing fallback. */
export const LOCAL_WORLD_REF: WorldRef = 'local'

/** One parsed execution-world reference. */
export type ParsedWorldRef =
  | { kind: 'local' }
  | { kind: 'wsl'; distro: string; user?: string }
  | { kind: 'ssh'; profileId: string }

/**
 * Parse a world reference into its kind and fields.
 * @param ref - the encoded reference.
 * @returns the parsed reference.
 * @throws when `ref` is not a valid {@link WorldRef} spelling.
 */
export function parseWorldRef(ref: string): ParsedWorldRef {
  if (ref === LOCAL_WORLD_REF) return { kind: 'local' }
  const [scheme, ...rest] = ref.split(':')
  if (scheme === 'wsl') {
    const [distro, user, extra] = rest
    if (extra === undefined && distro !== undefined && distro.length > 0 && (user === undefined || user.length > 0)) {
      return user === undefined ? { kind: 'wsl', distro } : { kind: 'wsl', distro, user }
    }
  }
  if (scheme === 'ssh') {
    const [profileId, extra] = rest
    if (extra === undefined && profileId !== undefined && profileId.length > 0) return { kind: 'ssh', profileId }
  }
  throw new Error(`invalid world reference: ${JSON.stringify(ref)}`)
}

/**
 * Test a string against the {@link WorldRef} grammar without throwing.
 * @param ref - the candidate reference.
 * @returns whether `ref` is a valid world reference.
 */
export function isWorldRef(ref: string): ref is WorldRef {
  try {
    parseWorldRef(ref)
    return true
  } catch {
    return false
  }
}

/**
 * Encode a parsed reference back to its string form; the parse/format pair
 * round-trips exactly.
 * @param parsed - the parsed reference.
 * @returns the encoded {@link WorldRef}.
 */
export function formatWorldRef(parsed: ParsedWorldRef): WorldRef {
  switch (parsed.kind) {
    case 'local':
      return LOCAL_WORLD_REF
    case 'wsl':
      return parsed.user === undefined ? `wsl:${parsed.distro}` : `wsl:${parsed.distro}:${parsed.user}`
    case 'ssh':
      return `ssh:${parsed.profileId}`
    /* v8 ignore next 4 -- ParsedWorldRef is a closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const kind: never = parsed
      throw new Error(`unreachable world reference kind: ${JSON.stringify(kind)}`)
    }
  }
}
