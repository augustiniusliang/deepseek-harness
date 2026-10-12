/** Volatile reference provider for protocol tests; never enables automatic recovery. */
import { isDeepStrictEqual } from 'node:util'
import { ExecutionCoordinator } from './service.ts'
import { ReceiptId, RuntimeEpoch, type RunId, type OperationId, type TransactionId, type ExecutionCommandId } from './brand.ts'
import { commitSchema } from './schema.ts'
import { ExecutionError, assertRunTransition, assertActivityTransition, isUnfinished } from './state.ts'
import type { Run, Activity, CommitBatch, CommitReceipt } from './types.ts'

type Accepted = { batch: CommitBatch; receipt: CommitReceipt }

/** In-memory oracle with atomic validation, detached reads and explicit volatile receipts. */
export class ReferenceExecutionCoordinator extends ExecutionCoordinator {
  readonly durability = 'volatile'
  private readonly epoch = RuntimeEpoch(1)
  private runs = new Map<RunId, Run>()
  private activities = new Map<OperationId, Activity>()
  private sequences = new Map<string, number>()
  private readonly transactions = new Map<TransactionId, Accepted>()
  private readonly commands = new Map<ExecutionCommandId, Accepted>()

  run(id: RunId): Promise<Run | undefined> { return Promise.resolve(structuredClone(this.runs.get(id))) }
  activity(id: OperationId): Promise<Activity | undefined> { return Promise.resolve(structuredClone(this.activities.get(id))) }
  receipt(id: TransactionId): Promise<CommitReceipt | undefined> {
    return Promise.resolve(structuredClone(this.transactions.get(id)?.receipt))
  }

  commit(batch: CommitBatch): Promise<CommitReceipt> {
    return Promise.resolve().then(() => this.commitNow(batch))
  }

  private commitNow(batch: CommitBatch): CommitReceipt {
    const admitted = commitSchema.parse(batch)
    if (admitted.epoch !== this.epoch) throw new ExecutionError('stale_epoch', 'Commit epoch is not current')
    const priorTransaction = this.transactions.get(admitted.transactionId)
    if (priorTransaction !== undefined) {
      if (!isDeepStrictEqual(priorTransaction.batch, admitted)) throw new ExecutionError('identity_conflict', 'Transaction reused with different data')
      return structuredClone(priorTransaction.receipt)
    }
    const priorCommand = this.commands.get(admitted.command.id)
    if (priorCommand !== undefined) {
      const { transactionId: priorId, ...prior } = priorCommand.batch
      const { transactionId: currentId, ...current } = admitted
      if (!isDeepStrictEqual(prior, current)) throw new ExecutionError('identity_conflict', `Command differs between ${priorId} and ${currentId}`)
      this.transactions.set(admitted.transactionId, { batch: admitted, receipt: priorCommand.receipt })
      return structuredClone(priorCommand.receipt)
    }
    const runs = new Map(this.runs)
    const activities = new Map(this.activities)
    const sequences = new Map(this.sequences)
    const touched = new Set<string>()
    const revisions: CommitReceipt['revisions'] = []
    for (const change of admitted.changes) {
      const key = `${change.kind}:${change.value.id}`
      if (touched.has(key)) throw new ExecutionError('revision_conflict', 'A record may appear only once per batch')
      touched.add(key)
      const previous = change.kind === 'run' ? runs.get(change.value.id) : activities.get(change.value.id)
      if ((previous?.revision ?? null) !== change.expectedRevision
        || change.value.revision !== (previous === undefined ? 0 : previous.revision + 1)) {
        throw new ExecutionError('revision_conflict', `Stale revision for ${key}`)
      }
      if (change.kind === 'run') {
        const old = runs.get(change.value.id)
        if (change.value.epoch !== this.epoch) throw new ExecutionError('stale_epoch', 'Run epoch is not current')
        if (old === undefined) {
          if (change.value.state !== 'queued') throw new ExecutionError('invalid_transition', 'New Run must be queued')
        } else {
          if (old.sessionId !== change.value.sessionId || old.owner !== change.value.owner
            || old.projectId !== change.value.projectId || old.cancelGeneration > change.value.cancelGeneration) {
            throw new ExecutionError('owner_conflict', 'Run identity, owner and cancellation generation cannot be rewritten')
          }
          assertRunTransition(old.state, change.value.state)
        }
        runs.set(change.value.id, change.value)
      } else {
        const old = activities.get(change.value.id)
        if (old === undefined) {
          if (change.value.state !== 'prepared') throw new ExecutionError('invalid_transition', 'New Activity must be prepared')
        } else {
          if (old.runId !== change.value.runId || old.attemptId !== change.value.attemptId
            || old.parentOperationId !== change.value.parentOperationId
            || old.ordinal !== change.value.ordinal || !isDeepStrictEqual(old.resolvedSpec, change.value.resolvedSpec)
            || !isDeepStrictEqual(old.recovery, change.value.recovery)) {
            throw new ExecutionError('identity_conflict', 'Reference provider cannot rewrite dispatched operation identity')
          }
          assertActivityTransition(old.state, change.value.state)
        }
        activities.set(change.value.id, change.value)
      }
      revisions.push({ kind: change.kind, id: change.value.id, revision: change.value.revision })
    }
    const owners = new Map<string, Run['owner']>()
    const active = new Set<string>()
    for (const run of runs.values()) {
      if (!isUnfinished(run)) continue
      const owner = owners.get(run.sessionId)
      if (owner !== undefined && owner !== run.owner) throw new ExecutionError('owner_conflict', 'Session has two orchestrators')
      owners.set(run.sessionId, run.owner)
      if (['running', 'recovering', 'cancelling'].includes(run.state)) {
        if (active.has(run.sessionId)) throw new ExecutionError('owner_conflict', 'Session has two active Runs')
        active.add(run.sessionId)
      }
    }
    for (const activity of activities.values()) {
      if (!runs.has(activity.runId)) throw new ExecutionError('identity_conflict', 'Activity references an absent Run')
      if (activity.parentOperationId !== undefined) {
        const parent = activities.get(activity.parentOperationId)
        if (parent === undefined || parent.runId !== activity.runId || parent.id === activity.id) {
          throw new ExecutionError('identity_conflict', 'Nested operation must name a distinct parent in the same Run')
        }
      }
      const ancestry = new Set<OperationId>([activity.id])
      let ancestor = activity.parentOperationId
      while (ancestor !== undefined) {
        if (ancestry.has(ancestor)) throw new ExecutionError('identity_conflict', 'Nested operation ancestry contains a cycle')
        ancestry.add(ancestor)
        ancestor = activities.get(ancestor)?.parentOperationId
      }
    }
    const sessionIds = new Set<string>()
    for (const append of admitted.sessions) {
      if (sessionIds.has(append.sessionId) || (sequences.get(append.sessionId) ?? 0) !== append.expectedSeq) {
        throw new ExecutionError('revision_conflict', 'Session sequence differs or appears twice')
      }
      sessionIds.add(append.sessionId)
      for (const event of append.events) {
        if (event.type !== 'execution/reference' && event.ignorable !== true) {
          throw new ExecutionError('unsupported_event', 'Reference provider knows only execution/reference events')
        }
      }
      sequences.set(append.sessionId, append.expectedSeq + append.events.length)
    }
    const receipt: CommitReceipt = {
      id: ReceiptId(`receipt:${admitted.transactionId}`), transactionId: admitted.transactionId,
      commandId: admitted.command.id, epoch: this.epoch, durability: 'volatile', revisions,
    }
    this.runs = runs
    this.activities = activities
    this.sequences = sequences
    const accepted = { batch: admitted, receipt }
    this.transactions.set(admitted.transactionId, accepted)
    this.commands.set(admitted.command.id, accepted)
    return structuredClone(receipt)
  }
}
