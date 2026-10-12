/** Execution commit service; concrete providers own atomicity, fencing and acknowledgement. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { RunId, OperationId, TransactionId } from './brand.ts'
import type { Run, Activity, CommitBatch, CommitReceipt } from './types.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    execution: ExecutionCoordinator
  }
}

/** One commit authority per Cordis realm; load a provider, never this abstract service. */
export abstract class ExecutionCoordinator extends Service {
  /** @param ctx - Realm owning the execution service. */
  constructor(ctx: Context) {
    if (new.target === ExecutionCoordinator) throw new Error('Load an execution provider, not the abstract coordinator')
    super(ctx, 'execution')
  }
  /** Whether acknowledged records survive process exit. */
  abstract readonly durability: 'volatile' | 'durable'
  /** Commit immutable facts atomically; no external operations run inside this call.
   * @param batch - Exact versioned request, including optimistic preconditions.
   * @returns The committed receipt, or the original receipt on an identical retry.
   */
  abstract commit(batch: CommitBatch): Promise<CommitReceipt>
  /** Resolve acknowledgement loss without issuing another external operation.
   * @param id - The original transaction identity.
   * @returns Its committed receipt, or undefined when absent.
   */
  abstract receipt(id: TransactionId): Promise<CommitReceipt | undefined>
  /** Read the committed Run snapshot.
   * @param id - Run identity.
   * @returns A detached snapshot or undefined.
   */
  abstract run(id: RunId): Promise<Run | undefined>
  /** Read the committed logical operation.
   * @param id - Operation identity.
   * @returns A detached snapshot or undefined.
   */
  abstract activity(id: OperationId): Promise<Activity | undefined>
}

export default ExecutionCoordinator
