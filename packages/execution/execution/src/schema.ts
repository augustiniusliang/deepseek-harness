/** Versioned JSON admission for execution records; strict readers reject unknown fields and versions. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  RunId, StepId, OperationId, AttemptId, WaitId, ExecutionCommandId, ReceiptId, TransactionId,
  ProjectId, TaskId, MemoryId, GrantId, BudgetId, RuntimeEpoch,
} from './brand.ts'

const identity = z.string().min(1)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const instant = z.iso.datetime()
const runId = identity.transform(RunId)
const operationId = identity.transform(OperationId)

/** Compatibility generation of execution JSON, independent of Session physical format. */
export const EXECUTION_PROTOCOL_VERSION = 1
/** Session orchestration is owned by exactly one implementation. */
export const ownerSchema = z.enum(['legacy', 'ettore'])
/** A Run may retain an open turn while waiting or paused. */
export const runStateSchema = z.enum(['queued', 'running', 'waiting', 'paused', 'recovering', 'cancelling', 'cancelled', 'completed', 'failed'])
/** Unknown outcome is not a failure and never implies permission to retry. */
export const activityStateSchema = z.enum(['prepared', 'dispatched', 'running', 'outcome_unknown', 'succeeded', 'failed', 'cancel_requested', 'cancelled'])
/** Immutable content identity; the owning store must verify length and hash before referencing it. */
export const artifactSchema = z.strictObject({
  uri: identity, sha256: digest, bytes: revision, mediaType: identity,
})
/** Run snapshot whose revision and epoch must be checked in the same commit as its events. */
export const runSchema = z.strictObject({
  version: z.literal(EXECUTION_PROTOCOL_VERSION), id: runId, sessionId: identity.transform(SessionId),
  projectId: identity.transform(ProjectId), owner: ownerSchema, revision,
  epoch: revision.min(1).transform(RuntimeEpoch), state: runStateSchema,
  stepId: identity.transform(StepId).optional(),
  phase: z.enum(['admit_input', 'request_model', 'commit_model', 'dispatch_tools', 'collect_tools', 'publish_results', 'advance_step', 'finish_turn']),
  parentRunId: runId.optional(), cancelGeneration: revision,
})
/** Trusted adapter policy recorded before dispatch; omitted capabilities do not imply replay safety. */
export const recoverySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual'), adapter: identity, version: revision.min(1) }),
  z.strictObject({ kind: z.literal('query'), adapter: identity, version: revision.min(1) }),
  z.strictObject({ kind: z.literal('idempotent'), adapter: identity, version: revision.min(1), retentionUntil: instant }),
])
/** One logical operation across attempts; the idempotency key is its stable operation identity. */
export const activitySchema = z.strictObject({
  id: operationId, runId, attemptId: identity.transform(AttemptId),
  ordinal: revision, parentOperationId: operationId.optional(), state: activityStateSchema,
  revision, resolvedSpec: artifactSchema, recovery: recoverySchema,
  receipt: artifactSchema.optional(),
})
/** Input is retained through claim; only acceptance, rejection or cancellation consumes it. */
export const inputSchema = z.strictObject({
  id: identity.transform(ExecutionCommandId), runId, content: artifactSchema,
  state: z.enum(['pending', 'claimed', 'accepted', 'rejected', 'cancelled']),
  claimEpoch: revision.min(1).transform(RuntimeEpoch).optional(),
})
/** Persisted waits carry their exact subject and a versioned answer, not a live Promise. */
export const waitSchema = z.strictObject({
  id: identity.transform(WaitId), runId, revision,
  state: z.enum(['pending', 'resolved', 'cancelled', 'expired']),
  condition: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('timer'), dueAt: instant }),
    z.strictObject({ kind: z.literal('approval'), operationId, resolvedSpecHash: digest }),
    z.strictObject({ kind: z.literal('user'), question: artifactSchema }),
    z.strictObject({ kind: z.literal('child'), childRunId: runId }),
    z.strictObject({ kind: z.literal('job'), operationId, world: identity }),
  ]),
  answer: artifactSchema.optional(),
})
/** Persisted recovery authority is scoped and revoked by cancellation generation. */
export const grantSchema = z.strictObject({
  id: identity.transform(GrantId), runId, owner: z.literal('ettore'),
  allowedActions: z.array(z.enum(['model', 'read', 'reconcile', 'idempotent-write'])),
  expiresAt: instant, cancelGeneration: revision, budgetId: identity.transform(BudgetId),
})
/** Shared budget reservation identity belongs to one actual attempt. */
export const reservationSchema = z.strictObject({
  budgetId: identity.transform(BudgetId), parentBudgetId: identity.transform(BudgetId).optional(),
  runId, attemptId: identity.transform(AttemptId),
  state: z.enum(['reserved', 'settled', 'released', 'unknown']),
  tokens: revision, costMicros: revision, deadline: instant,
})
/** Exact model input is immutable and linked to a pre-dispatch budget reservation. */
export const modelRequestSchema = z.strictObject({
  runId, stepId: identity.transform(StepId), operationId,
  attemptId: identity.transform(AttemptId), request: artifactSchema, history: artifactSchema,
  tools: artifactSchema, route: identity, reservation: reservationSchema,
})
/** A source-qualified memory revision is contextual evidence, never execution authority. */
export const memoryRefSchema = z.strictObject({
  id: identity.transform(MemoryId), revision, projectId: identity.transform(ProjectId).optional(),
  content: artifactSchema,
})
/** Stable user goal and constraints; every amendment requires a new revision. */
export const workSpecSchema = z.strictObject({
  taskId: identity.transform(TaskId), revision, projectId: identity.transform(ProjectId),
  goal: artifactSchema, constraints: artifactSchema, acceptance: artifactSchema,
  budgetId: identity.transform(BudgetId), deadline: instant.optional(),
})
/** Evidence-based handoff survives compaction; it never grants additional authority. */
export const workPacketSchema = z.strictObject({
  taskId: identity.transform(TaskId), revision, runId, specRevision: revision,
  completed: z.array(artifactSchema), unresolved: z.array(operationId),
  next: artifactSchema, memories: z.array(memoryRefSchema),
})
/** Completion reports name the acceptance revision and immutable verification evidence. */
export const verificationSchema = z.strictObject({
  taskId: identity.transform(TaskId), specRevision: revision,
  verdict: z.enum(['passed', 'failed', 'inconclusive']), evidence: z.array(artifactSchema).min(1),
})
/** One closed mutation vocabulary; later domains extend it only with an explicit protocol revision. */
export const changeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), expectedRevision: revision.nullable(), value: runSchema }),
  z.strictObject({ kind: z.literal('activity'), expectedRevision: revision.nullable(), value: activitySchema }),
])
/** Opaque event bytes retain Session's required-event checks in the owning provider. */
export const sessionAppendSchema = z.strictObject({
  sessionId: identity.transform(SessionId), expectedSeq: revision,
  events: z.array(z.strictObject({ type: identity, data: z.json(), ignorable: z.literal(true).optional() })),
})
/** Pure commit data; a provider must never execute user callbacks or network work inside its transaction. */
export const commitSchema = z.strictObject({
  version: z.literal(EXECUTION_PROTOCOL_VERSION),
  transactionId: identity.transform(TransactionId), epoch: revision.min(1).transform(RuntimeEpoch),
  command: z.strictObject({ id: identity.transform(ExecutionCommandId), payload: artifactSchema }),
  changes: z.array(changeSchema).min(1),
  sessions: z.array(sessionAppendSchema),
})
/** Only a committed receipt authorizes subsequent dispatch; acknowledgement loss is queried by transaction ID. */
export const receiptSchema = z.strictObject({
  id: identity.transform(ReceiptId), transactionId: identity.transform(TransactionId),
  commandId: identity.transform(ExecutionCommandId), epoch: revision.min(1).transform(RuntimeEpoch),
  durability: z.enum(['volatile', 'durable']),
  revisions: z.array(z.strictObject({ kind: z.enum(['run', 'activity']), id: identity, revision })),
})
