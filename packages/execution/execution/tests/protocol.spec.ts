import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExecutionCoordinator, RuntimeEpoch, RunId, TransactionId, OperationId,
  commitSchema, runSchema, activitySchema, waitSchema, grantSchema, inputSchema,
  reservationSchema, modelRequestSchema, workSpecSchema, workPacketSchema, verificationSchema,
  recoveryKind, idempotencyKey, assertRunTransition, assertActivityTransition,
  type CommitBatch, type Run, type Activity,
} from '../src/index.ts'
import { ReferenceExecutionCoordinator } from '../src/reference.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const blob = { uri: 'artifact:fixture', sha256: 'a'.repeat(64), bytes: 3, mediaType: 'text/plain' }
function run(id = 'run-1'): Run {
  return runSchema.parse({ version: 1, id, sessionId: 'session-1', projectId: 'project-1',
    owner: 'ettore', revision: 0, epoch: 1, state: 'queued', phase: 'admit_input', cancelGeneration: 0 })
}
function batch(value = run(), ordinal = 0): CommitBatch {
  return commitSchema.parse({ version: 1, transactionId: `tx-${ordinal}`, epoch: 1,
    command: { id: `command-${ordinal}`, payload: blob },
    changes: [{ kind: 'run', expectedRevision: value.revision === 0 ? null : value.revision - 1, value }],
    sessions: [] })
}
function activity(): Activity {
  return activitySchema.parse({ id: 'operation-1', runId: 'run-1', attemptId: 'attempt-1',
    ordinal: 0, state: 'prepared', revision: 0, resolvedSpec: blob,
    recovery: { kind: 'manual', adapter: 'fixture', version: 1 } })
}
async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ReferenceExecutionCoordinator)
  return ctx
}
function activityBatch(value: Activity, ordinal: number): CommitBatch {
  return { ...batch(run(), ordinal), changes: [{ kind: 'activity', expectedRevision: value.revision === 0 ? null : value.revision - 1, value }] }
}

describe('execution reference provider', () => {
  it('commits, queries lost acknowledgement, deduplicates and detaches returned state', async () => {
    const ctx = await setup()
    const first = batch()
    const receipt = await ctx.execution.commit(first)
    expect(receipt.durability).toBe('volatile')
    expect(await ctx.execution.receipt(first.transactionId)).toEqual(receipt)
    expect(await ctx.execution.commit(first)).toEqual(receipt)
    expect(await ctx.execution.commit({ ...first, transactionId: TransactionId('alias') })).toEqual(receipt)
    expect(await ctx.execution.receipt(TransactionId('alias'))).toEqual(receipt)
    const snapshot = (await ctx.execution.run(RunId('run-1')))!
    snapshot.revision = 99
    expect((await ctx.execution.run(snapshot.id))?.revision).toBe(0)
    expect(await ctx.execution.run(RunId('absent'))).toBeUndefined()
    expect(await ctx.execution.activity(OperationId('absent'))).toBeUndefined()
    expect(await ctx.execution.receipt(TransactionId('absent'))).toBeUndefined()
  })
  it('rejects transaction and command identity reuse with different payloads', async () => {
    const ctx = await setup()
    const first = batch()
    await ctx.execution.commit(first)
    const changed = { ...first, command: { ...first.command, payload: { ...blob, bytes: 4 } } }
    await expect(ctx.execution.commit(changed)).rejects.toMatchObject({ code: 'identity_conflict' })
    await expect(ctx.execution.commit({ ...changed, transactionId: TransactionId('new-tx') })).rejects.toMatchObject({ code: 'identity_conflict' })
  })
  it('rejects stale epochs and revisions without any partial write', async () => {
    const ctx = await setup()
    await ctx.execution.commit(batch())
    await expect(ctx.execution.commit({ ...batch(run('second'), 1), epoch: RuntimeEpoch(2) })).rejects.toMatchObject({ code: 'stale_epoch' })
    const next = batch({ ...run(), revision: 1, state: 'running' }, 2)
    await expect(ctx.execution.commit({ ...next, changes: [...next.changes, ...batch(run(), 3).changes] })).rejects.toMatchObject({ code: 'revision_conflict' })
    expect((await ctx.execution.run(RunId('run-1')))?.state).toBe('queued')
    await expect(ctx.execution.commit(batch({ ...run(), revision: 9 }, 4))).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(await ctx.execution.receipt(TransactionId('tx-2'))).toBeUndefined()
  })
  it('prevents two owners and two active Runs in one Session', async () => {
    const ctx = await setup()
    await ctx.execution.commit(batch())
    await expect(ctx.execution.commit(batch({ ...run('legacy'), owner: 'legacy' }, 1))).rejects.toMatchObject({ code: 'owner_conflict' })
    await ctx.execution.commit(batch({ ...run(), revision: 1, state: 'running' }, 2))
    await ctx.execution.commit(batch(run('second'), 3))
    await expect(ctx.execution.commit(batch({ ...run('second'), revision: 1, state: 'running' }, 4))).rejects.toMatchObject({ code: 'owner_conflict' })
    await expect(ctx.execution.commit(batch({ ...run(), revision: 2, owner: 'legacy' }, 5))).rejects.toMatchObject({ code: 'owner_conflict' })
    await ctx.execution.commit(batch({ ...run(), revision: 2, state: 'completed' }, 6))
    await ctx.execution.commit(batch({ ...run('second'), revision: 1, state: 'running' }, 7))
  })
  it('refuses invalid initial states and ownership epochs', async () => {
    const ctx = await setup()
    await expect(ctx.execution.commit(batch({ ...run(), state: 'completed' }))).rejects.toMatchObject({ code: 'invalid_transition' })
    await expect(ctx.execution.commit(batch({ ...run(), epoch: RuntimeEpoch(2) }))).rejects.toMatchObject({ code: 'stale_epoch' })
    await expect(ctx.execution.commit(activityBatch({ ...activity(), state: 'succeeded' }, 2))).rejects.toMatchObject({ code: 'invalid_transition' })
    await expect(ctx.execution.commit(activityBatch(activity(), 3))).rejects.toMatchObject({ code: 'identity_conflict' })
  })
  it('preserves an unknown effect, records a late success and cannot revive a cancelled Run', async () => {
    const ctx = await setup()
    await ctx.execution.commit(batch())
    await ctx.execution.commit(activityBatch(activity(), 1))
    await ctx.execution.commit(activityBatch({ ...activity(), revision: 1, state: 'dispatched' }, 2))
    await ctx.execution.commit(activityBatch({ ...activity(), revision: 2, state: 'outcome_unknown' }, 3))
    await ctx.execution.commit(batch({ ...run(), revision: 1, state: 'cancelling', cancelGeneration: 1 }, 4))
    await ctx.execution.commit(batch({ ...run(), revision: 2, state: 'cancelled', cancelGeneration: 1 }, 5))
    await ctx.execution.commit(activityBatch({ ...activity(), revision: 3, state: 'succeeded', receipt: blob }, 6))
    expect((await ctx.execution.activity(OperationId('operation-1')))?.state).toBe('succeeded')
    expect((await ctx.execution.run(RunId('run-1')))?.state).toBe('cancelled')
    await expect(ctx.execution.commit(batch({ ...run(), revision: 3, state: 'running', cancelGeneration: 1 }, 7))).rejects.toMatchObject({ code: 'invalid_transition' })
    await expect(ctx.execution.commit(activityBatch({ ...activity(), revision: 4, state: 'dispatched' }, 8))).rejects.toMatchObject({ code: 'invalid_transition' })
  })
  it('checks Session sequences and unknown required events in the same atomic batch', async () => {
    const ctx = await setup()
    const first = batch()
    const append = commitSchema.parse({ ...first, sessions: [{ sessionId: 'session-1', expectedSeq: 0, events: [{ type: 'execution/reference', data: { openTurn: true } }] }] })
    await ctx.execution.commit(append)
    const next = batch({ ...run(), revision: 1 }, 1)
    await expect(ctx.execution.commit({ ...next, sessions: append.sessions })).rejects.toMatchObject({ code: 'revision_conflict' })
    const unsupported = commitSchema.parse({ ...next, sessions: [{ sessionId: 'session-1', expectedSeq: 1, events: [{ type: 'future/required', data: null }] }] })
    await expect(ctx.execution.commit(unsupported)).rejects.toMatchObject({ code: 'unsupported_event' })
    expect((await ctx.execution.run(RunId('run-1')))?.revision).toBe(0)
    await ctx.execution.commit({ ...unsupported,
      sessions: unsupported.sessions.map(s => ({ ...s, events: s.events.map(e => ({ ...e, ignorable: true })) })),
    })
  })
  it('cannot load the abstract provider or two providers in one realm', async () => {
    expect(() => { Reflect.construct(ExecutionCoordinator, [new Context()]) }).toThrow('Load an execution provider')
    const ctx = await setup()
    expect(() => new ReferenceExecutionCoordinator(ctx)).toThrow()
  })
  it('rejects missing parents, cycles and parent rewrites atomically', async () => {
    const ctx = await setup()
    await ctx.execution.commit(batch())
    const parent = activity()
    const child = { ...activity(), id: OperationId('child'), parentOperationId: parent.id }
    await expect(ctx.execution.commit(activityBatch(child, 1))).rejects.toMatchObject({ code: 'identity_conflict' })
    const cyclic = { ...parent, parentOperationId: child.id }
    await expect(ctx.execution.commit({ ...batch(run(), 2), changes: [
      { kind: 'activity', expectedRevision: null, value: cyclic },
      { kind: 'activity', expectedRevision: null, value: child },
    ] })).rejects.toMatchObject({ code: 'identity_conflict' })
    expect(await ctx.execution.activity(child.id)).toBeUndefined()
    await ctx.execution.commit(activityBatch(parent, 3))
    await ctx.execution.commit(activityBatch(child, 4))
    await expect(ctx.execution.commit(activityBatch({ ...child, revision: 1, parentOperationId: child.id }, 5)))
      .rejects.toMatchObject({ code: 'identity_conflict' })
    expect((await ctx.execution.activity(child.id))?.revision).toBe(0)
  })
})

describe('execution JSON and policy vocabulary', () => {
  it('rejects unknown versions, owner tags and ambiguous fields', () => {
    expect(() => runSchema.parse({ ...run(), owner: 'both' })).toThrow()
    expect(() => commitSchema.parse({ ...batch(), version: 2 })).toThrow()
    expect(() => commitSchema.parse({ ...batch(), execute: 'shell' })).toThrow()
  })
  it('admits wait, grant, reservation and exact request evidence without becoming authority', () => {
    const reservation = reservationSchema.parse({ budgetId: 'budget', parentBudgetId: 'parent',
      runId: 'run-1', attemptId: 'attempt-1', state: 'reserved', tokens: 100,
      costMicros: 20, deadline: '2026-10-13T00:00:00Z' })
    expect(modelRequestSchema.parse({ runId: 'run-1', stepId: 'step-1', operationId: 'op',
      attemptId: 'attempt-1', request: blob, history: blob, tools: blob, route: 'fixture',
      reservation }).reservation).toEqual(reservation)
    expect(grantSchema.parse({ id: 'grant', runId: 'run-1', owner: 'ettore', allowedActions: ['read'],
      expiresAt: '2026-10-13T00:00:00Z', cancelGeneration: 0, budgetId: 'budget' }).owner).toBe('ettore')
    expect(waitSchema.parse({ id: 'wait', runId: 'run-1', revision: 0, state: 'pending',
      condition: { kind: 'approval', operationId: 'op', resolvedSpecHash: blob.sha256 } }).state).toBe('pending')
    expect(inputSchema.parse({ id: 'input', runId: 'run-1', content: blob, state: 'claimed', claimEpoch: 1 }).state).toBe('claimed')
  })
  it('keeps work acceptance revisions and source-qualified memory references in handoffs', () => {
    expect(workSpecSchema.parse({ taskId: 'task', revision: 0, projectId: 'project', goal: blob,
      constraints: blob, acceptance: blob, budgetId: 'budget' }).revision).toBe(0)
    expect(workPacketSchema.parse({ taskId: 'task', revision: 1, runId: 'run-1', specRevision: 0,
      completed: [blob], unresolved: ['op'], next: blob,
      memories: [{ id: 'memory', revision: 3, projectId: 'project', content: blob }] }).memories[0]?.revision).toBe(3)
    expect(() => verificationSchema.parse({ taskId: 'task', specRevision: 0, verdict: 'passed', evidence: [] })).toThrow()
  })
  it('defaults recovery to manual and keeps the key independent of attempt', () => {
    expect(recoveryKind()).toBe('manual')
    expect(recoveryKind({ kind: 'query', adapter: 'fixture', version: 1 })).toBe('query')
    expect(idempotencyKey(OperationId('op'))).toBe('op')
    expect(idempotencyKey(OperationId('op-2'))).not.toBe('op')
    expect(() => { assertRunTransition('queued', 'queued') }).not.toThrow()
    expect(() => { assertActivityTransition('prepared', 'prepared') }).not.toThrow()
  })
})
