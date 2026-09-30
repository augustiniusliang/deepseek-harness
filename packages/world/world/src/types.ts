/**
 * Pure types of the execution-world domain: the `WorldRef` string encoding and
 * the `world` projection's state and client-view keys, free of this package's
 * host-side value imports (cordis, dsh-fs, dsh-subprocess). The `./types`
 * projection serves host consumers.
 *
 * @module @deepseek-ai/dsh-world/types
 */

/**
 * One execution world, string-encoded: `'local'`, `'wsl:<distro>'`,
 * `'wsl:<distro>:<user>'`, or `'ssh:<profileId>'`. Validate with
 * `isWorldRef`/`parseWorldRef` from the package root; the type itself is the
 * plain durable and wire form.
 */
export type WorldRef = string

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The session's current execution world — its last `session/world` event, or the world detected from its creation cwd. */
    world: WorldRef
  }
  interface SessionProjectionMap {
    /** The session's current execution world, for client display and remote export. */
    world: WorldRef
  }
}
