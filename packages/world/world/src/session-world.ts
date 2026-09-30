/**
 * Per-session execution world: the session log as the store, mirroring the
 * `sandbox/mode` kit. A world change is recorded as one `session/world` event
 * on the session it applies to; `effective = projection state ?? detected from
 * the creation cwd`, so the choice survives restart by replay, two sessions
 * can never see each other's state, and there is no external config store. The
 * event is log-only: the world registry projects the fold for consumers, and
 * capability routing derives from the projected value.
 *
 * @module @deepseek-ai/dsh-world/session-world
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { WorldRef } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's execution world was replaced — log-only (like
     * `sandbox/mode`; NOT a surface event, carries no `surfaceOp`): durable
     * and replayable, never in the model transcript. The LAST such event is
     * the session's world (folded by the `world` projection unit); a session
     * without one runs in the world detected from its creation cwd.
     */
    'session/world': {
      /** The complete world the session runs in from this event on (`'local'`, `'wsl:<distro>[:<user>]'`, or `'ssh:<profileId>'`). */
      world: WorldRef
    }
  }
}

/**
 * THE write path for a session's execution world: appends exactly one
 * `session/world` event — the reference IS its event; nothing mutates world
 * state out of band, and the fold REPLACES rather than accumulates. Callers
 * validate the reference with `isWorldRef` before recording; the invariant
 * companion rejects a forged payload.
 * @param session - the session the world applies to.
 * @param world - the world every subsequent capability call in this session
 *   routes to (until the next event).
 */
export function setSessionWorld(session: Session, world: WorldRef): void {
  session.append('session/world', { world })
}
