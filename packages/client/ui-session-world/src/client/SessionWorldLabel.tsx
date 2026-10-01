/**
 * The session header's execution-world chip.
 *
 * Read-only by construction: a session's world follows from its workspace
 * path, never from a user pick, so the header only names where the session's
 * capability calls run. There is no switch to offer — the hover tooltip
 * carries the full reference and says the routing is automatic.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-world/types'
import { worldLabel } from './locales.ts'
import css from './SessionWorldLabel.module.css'

/** Registration-side business face for the header chip (empty: the projection is already wired). */
export type SessionWorldLabelInjected = Record<string, never>

/** Full component props. */
export type SessionWorldLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'session.world'>
  & InjectFace<SessionWorldLabelInjected>

/**
 * Render this session's execution world beside its title.
 * @param props - composed slot props.
 * @returns the chip, or null when the session carries no world projection.
 */
export function SessionWorldLabel({ sessionId, useSessions, t }: SessionWorldLabelProps) {
  const world = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.world
    return typeof value === 'string' ? value : undefined
  })
  if (world === undefined) return null
  return (
    <span className={css.label} title={t('hint', { ref: world })}>
      <IconGlobeOutlineRegular size={14} className={css.icon} />
      {worldLabel(world, t)}
    </span>
  )
}
