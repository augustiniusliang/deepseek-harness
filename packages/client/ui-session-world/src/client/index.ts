/**
 * Session-world chip plugin, browser half — one read-only label in the
 * session header naming the execution world the session runs in (`本机`,
 * `WSL · <distro>`, `SSH · <profile>`). The world projection is wired by the
 * host's world registry (P0), so this surface only reads it; there is no
 * world switch, and the new-session hero needs no seat because the workspace
 * chip already implies the world a fresh session will start in.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the Session Controller service merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SessionWorldLabel } from './SessionWorldLabel.tsx'
import type { SessionWorldLabelInjected } from './SessionWorldLabel.tsx'
import { en, zh, type SessionWorldKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-world chip copy. */
    'session.world': SessionWorldKey
  }
}

export type { SessionWorldLabelInjected, SessionWorldLabelProps } from './SessionWorldLabel.tsx'
export { worldLabel } from './locales.ts'
export type { SessionWorldKey } from './locales.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Mount the header chip.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('session.world', { zh, en }), 'ui-session-world: chip dictionaries')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'session-world',
    // Static session context occupies the header's leading negative-order
    // band; the world chip trails the agent-preset label (-10).
    order: -9,
    locale: 'session.world',
    inject: (): SessionWorldLabelInjected => ({}),
  }, SessionWorldLabel)), 'ui-session-world: header chip')
}
