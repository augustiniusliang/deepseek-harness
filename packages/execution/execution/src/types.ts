/** Execution protocol types inferred from the authoritative JSON readers. */
import type { z } from 'zod'
import type {
  runSchema, activitySchema, commitSchema, receiptSchema, waitSchema, grantSchema,
  reservationSchema, modelRequestSchema, inputSchema, workSpecSchema, workPacketSchema,
  memoryRefSchema, verificationSchema, recoverySchema, artifactSchema,
} from './schema.ts'

/** Admitted Run data; JSON inputs must pass the corresponding schema. */
export type Run = z.infer<typeof runSchema>
/** Admitted Activity data; JSON inputs must pass the corresponding schema. */
export type Activity = z.infer<typeof activitySchema>
/** Admitted CommitBatch data; JSON inputs must pass the corresponding schema. */
export type CommitBatch = z.infer<typeof commitSchema>
/** Admitted CommitReceipt data; JSON inputs must pass the corresponding schema. */
export type CommitReceipt = z.infer<typeof receiptSchema>
/** Admitted Wait data; JSON inputs must pass the corresponding schema. */
export type Wait = z.infer<typeof waitSchema>
/** Admitted RecoveryGrant data; JSON inputs must pass the corresponding schema. */
export type RecoveryGrant = z.infer<typeof grantSchema>
/** Admitted Reservation data; JSON inputs must pass the corresponding schema. */
export type Reservation = z.infer<typeof reservationSchema>
/** Admitted ModelRequest data; JSON inputs must pass the corresponding schema. */
export type ModelRequest = z.infer<typeof modelRequestSchema>
/** Admitted Input data; JSON inputs must pass the corresponding schema. */
export type Input = z.infer<typeof inputSchema>
/** Admitted WorkSpec data; JSON inputs must pass the corresponding schema. */
export type WorkSpec = z.infer<typeof workSpecSchema>
/** Admitted WorkPacket data; JSON inputs must pass the corresponding schema. */
export type WorkPacket = z.infer<typeof workPacketSchema>
/** Admitted MemoryRef data; JSON inputs must pass the corresponding schema. */
export type MemoryRef = z.infer<typeof memoryRefSchema>
/** Admitted Verification data; JSON inputs must pass the corresponding schema. */
export type Verification = z.infer<typeof verificationSchema>
/** Admitted RecoveryDescriptor data; JSON inputs must pass the corresponding schema. */
export type RecoveryDescriptor = z.infer<typeof recoverySchema>
/** Admitted ArtifactRef data; JSON inputs must pass the corresponding schema. */
export type ArtifactRef = z.infer<typeof artifactSchema>

/** External observations are explicit; absence of a receipt never means the effect failed. */
export type ActivityObservation =
  | { readonly kind: 'running' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'succeeded' | 'failed' | 'cancelled'; readonly receipt: ArtifactRef }

/** Trusted implementation selected by the persisted adapter name and version. */
export interface ActivityAdapter {
  /** Stable adapter name; model output cannot register adapters. */
  readonly name: string
  /** Implementation version required by persisted recovery descriptors. */
  readonly version: number
  /** Dispatch only after the coordinator has committed intent, approval and reservation.
   * @param activity - Already admitted attempt with immutable resolved parameters.
   * @param signal - Current cancellation request, not proof that remote work stopped.
   * @returns External observation to commit before publishing results.
   */
  execute(activity: Activity, signal: AbortSignal): Promise<ActivityObservation>
  /** Inspect the same logical operation without submitting it again.
   * @param activity - Operation whose outcome needs reconciliation.
   * @param signal - Cancellation of the inspection.
   * @returns Observation; not-found or offline remains unknown without stronger evidence.
   */
  query(activity: Activity, signal: AbortSignal): Promise<ActivityObservation>
  /** Reconcile a prior unknown outcome without granting a new dispatch.
   * @param activity - Interrupted logical operation.
   * @param signal - Cancellation of the reconciliation.
   * @returns Independently verified external observation.
   */
  reconcile(activity: Activity, signal: AbortSignal): Promise<ActivityObservation>
  /** Request cancellation; return cancelled only after external confirmation.
   * @param activity - Logical operation to stop.
   * @param signal - Deadline signal for the cancellation request.
   * @returns A late success or unknown result remains a valid observation.
   */
  cancel(activity: Activity, signal: AbortSignal): Promise<ActivityObservation>
}
