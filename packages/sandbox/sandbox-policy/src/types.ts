/**
 * Pure types of the sandbox-policy domain: the extra-writable-roots projection
 * key and its value, free of this package's host-side value imports (cordis,
 * dsh-sandbox, dsh-session). Two namespace projections serve it — `./types`
 * for host consumers and `./client` for client aggregates — with zero content
 * duplication.
 *
 * @module @deepseek-ai/dsh-sandbox-policy/types
 */

/**
 * The session's complete extra-writable-roots list at the last
 * `sandbox/extra-roots` event, or `null` before one. The list REPLACES rather
 * than accumulates, and an empty list restores the single-root boundary.
 */
export type SandboxExtraRoots = string[] | null

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged extra-writable-roots list, or null before one (no extra roots apply at resolve time). */
    sandboxExtraRoots: SandboxExtraRoots
  }
  interface SessionProjectionMap {
    /** Extra roots the session may write under, primary workspace root excluded; consumers browse or enforce them beside it. */
    sandboxExtraRoots: SandboxExtraRoots
  }
}
