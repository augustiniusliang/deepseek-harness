/** State transitions and recovery decisions enforced by commit providers. */
import type { Run, Activity, RecoveryDescriptor } from './types.ts'
import type { OperationId } from './brand.ts'

/** Execution failures are actionable categories, not permission to replay effects. */
export type ExecutionErrorCode = 'invalid_transition' | 'stale_epoch' | 'revision_conflict' | 'identity_conflict' | 'owner_conflict' | 'unsupported_event'

/** Rejected execution mutations leave all committed state unchanged. */
export class ExecutionError extends Error {
  /** @param code - Stable rejection category.
   * @param message - Specific violated precondition.
   */
  constructor(readonly code: ExecutionErrorCode, message: string) { super(message) }
}

const runTransitions: Record<Run['state'], readonly Run['state'][]> = {
  queued: ['running', 'paused', 'cancelling'],
  running: ['waiting', 'paused', 'recovering', 'cancelling', 'completed', 'failed'],
  waiting: ['queued', 'paused', 'cancelling', 'failed'],
  paused: ['queued', 'cancelling'],
  recovering: ['queued', 'waiting', 'paused', 'cancelling', 'failed'],
  cancelling: ['cancelled'],
  cancelled: [], completed: [], failed: [],
}
const activityTransitions: Record<Activity['state'], readonly Activity['state'][]> = {
  prepared: ['dispatched', 'cancelled'],
  dispatched: ['running', 'outcome_unknown', 'succeeded', 'failed', 'cancel_requested'],
  running: ['outcome_unknown', 'succeeded', 'failed', 'cancel_requested'],
  outcome_unknown: ['running', 'succeeded', 'failed', 'cancel_requested', 'cancelled'],
  cancel_requested: ['cancelled', 'outcome_unknown', 'succeeded', 'failed'],
  succeeded: [], failed: [], cancelled: [],
}

/** Validate a Run transition; same-state revisions are permitted.
 * @param before - Committed state.
 * @param after - Proposed state.
 */
export function assertRunTransition(before: Run['state'], after: Run['state']): void {
  if (before !== after && !runTransitions[before].includes(after)) {
    throw new ExecutionError('invalid_transition', `Run cannot move from ${before} to ${after}`)
  }
}
/** Validate an Activity transition; terminal effects cannot be dispatched again.
 * @param before - Committed state.
 * @param after - Proposed state.
 */
export function assertActivityTransition(before: Activity['state'], after: Activity['state']): void {
  if (before !== after && !activityTransitions[before].includes(after)) {
    throw new ExecutionError('invalid_transition', `Activity cannot move from ${before} to ${after}`)
  }
}
/** Determine whether a Run still owns unfinished work.
 * @param run - Committed Run.
 * @returns Whether the Session must retain its owner.
 */
export function isUnfinished(run: Run): boolean {
  return !['completed', 'failed', 'cancelled'].includes(run.state)
}
/** Obtain the idempotency key for a logical effect, independent of attempt.
 * @param operationId - Stable logical identity, never a hash of arguments.
 * @returns The same identity on every attempt.
 */
export function idempotencyKey(operationId: OperationId): string { return operationId }
/** Classify interrupted work without granting replay authority.
 * @param descriptor - Trusted adapter declaration; absent means manual reconciliation.
 * @returns The declared capability or manual reconciliation.
 */
export function recoveryKind(descriptor?: RecoveryDescriptor): RecoveryDescriptor['kind'] {
  return descriptor?.kind ?? 'manual'
}
