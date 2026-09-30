/** Package-owned session-event invariants for the execution-world registry. @module @deepseek-ai/dsh-world/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { isWorldRef } from './ref.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-world'

/** Cordis companion plugin name. */
export const name = 'world-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'session/world'
    && (typeof event.data.world !== 'string' || !isWorldRef(event.data.world))) {
    fail(`session/world carries invalid world reference ${JSON.stringify(event.data.world)}`)
  }
}

/** Install validation for loaded and newly appended world references. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.snapshotEvents()) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
