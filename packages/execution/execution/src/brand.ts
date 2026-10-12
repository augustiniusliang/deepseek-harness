/** Stable execution identities shared by persistent providers and consumers. */
import { brandString, brandNumber, type Branded, type BrandedNumber } from '@deepseek-ai/dsh-brand'

/** Stable run identity; constructors do not validate external input. */
export type RunId = Branded<'ExecutionRunId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function RunId(value: string): RunId { return brandString<RunId>(value) }

/** Stable step identity; constructors do not validate external input. */
export type StepId = Branded<'ExecutionStepId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function StepId(value: string): StepId { return brandString<StepId>(value) }

/** Stable operation identity; constructors do not validate external input. */
export type OperationId = Branded<'ExecutionOperationId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function OperationId(value: string): OperationId { return brandString<OperationId>(value) }

/** Stable attempt identity; constructors do not validate external input. */
export type AttemptId = Branded<'ExecutionAttemptId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function AttemptId(value: string): AttemptId { return brandString<AttemptId>(value) }

/** Stable wait identity; constructors do not validate external input. */
export type WaitId = Branded<'ExecutionWaitId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function WaitId(value: string): WaitId { return brandString<WaitId>(value) }

/** Stable command identity; constructors do not validate external input. */
export type ExecutionCommandId = Branded<'ExecutionCommandId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function ExecutionCommandId(value: string): ExecutionCommandId { return brandString<ExecutionCommandId>(value) }

/** Stable receipt identity; constructors do not validate external input. */
export type ReceiptId = Branded<'ExecutionReceiptId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function ReceiptId(value: string): ReceiptId { return brandString<ReceiptId>(value) }

/** Stable transaction identity; constructors do not validate external input. */
export type TransactionId = Branded<'ExecutionTransactionId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function TransactionId(value: string): TransactionId { return brandString<TransactionId>(value) }

/** Stable project identity; constructors do not validate external input. */
export type ProjectId = Branded<'ExecutionProjectId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function ProjectId(value: string): ProjectId { return brandString<ProjectId>(value) }

/** Stable task identity; constructors do not validate external input. */
export type TaskId = Branded<'ExecutionTaskId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function TaskId(value: string): TaskId { return brandString<TaskId>(value) }

/** Stable memory identity; constructors do not validate external input. */
export type MemoryId = Branded<'ExecutionMemoryId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function MemoryId(value: string): MemoryId { return brandString<MemoryId>(value) }

/** Stable grant identity; constructors do not validate external input. */
export type GrantId = Branded<'ExecutionGrantId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function GrantId(value: string): GrantId { return brandString<GrantId>(value) }

/** Stable budget identity; constructors do not validate external input. */
export type BudgetId = Branded<'ExecutionBudgetId'>
/** Apply the identity brand to an admitted string.
 * @param value - Validated identity.
 * @returns The branded identity.
 */
export function BudgetId(value: string): BudgetId { return brandString<BudgetId>(value) }

/** Monotonic fencing generation issued only by the owning store. */
export type RuntimeEpoch = BrandedNumber<'ExecutionRuntimeEpoch'>
/** Brand a store-issued fencing generation.
 * @param value - Positive safe integer checked at the store boundary.
 * @returns The branded generation.
 */
export function RuntimeEpoch(value: number): RuntimeEpoch { return brandNumber<RuntimeEpoch>(value) }
