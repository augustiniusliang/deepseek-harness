/**
 * Per-session extra writable roots: the session log as the store, mirroring
 * the `sandbox/mode` kit. A runtime change is recorded as one
 * `sandbox/extra-roots` event on the session it applies to;
 * `effective = projection state ?? no extra roots`, so the list survives
 * restart by replay, two sessions can never see each other's state, and
 * there is no external config store. The event is log-only (the
 * `sandbox/mode` precedent): the policy owner projects the fold into each
 * model request, while enforcing tools report operation-specific boundary
 * markers. EXECUTION honors the same fold through `ctx.sandboxPolicy.resolve()`
 * — it stamps the list together with the mode and workspace root onto each
 * capability call, and `writableRoots` plus every enforcing backend derive
 * their allow-list from it.
 *
 * @module dsh-sandbox-policy/session-extra-roots
 */

import type { Session } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's extra writable roots were replaced — log-only (like
     * `sandbox/mode`; NOT a surface event, carries no `surfaceOp`): durable
     * and replayable, never in the model transcript. The LAST such event is
     * the session's complete list (folded by the sandboxExtraRoots projection
     * unit); an empty list clears the extra roots.
     */
    'sandbox/extra-roots': {
      /** The complete list of additional absolute roots `workspace-write` may write under. */
      roots: string[]
    }
  }
}

/**
 * THE write path for a session's extra writable roots: appends exactly one
 * `sandbox/extra-roots` event — the list IS its event; nothing mutates
 * extra-root state out of band, and the fold REPLACES rather than
 * accumulates. Takes effect on the session's next confined call (bash or fs)
 * — consumers read the shared projection state.
 * @param session - the session the roots belong to.
 * @param roots - the complete extra-root list every subsequent confined call
 *   in this session allows under `workspace-write` (until the next event);
 *   an empty list restores the single-root boundary.
 */
export function setExtraWritableRoots(session: Session, roots: string[]): void {
  session.append('sandbox/extra-roots', { roots })
}
