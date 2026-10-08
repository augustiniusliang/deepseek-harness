/**
 * Fault-injection test facility for durable-session behavior. It boots real
 * headless dsh hosts against an isolated per-test runtime, lets a fixture
 * plugin inside the host SIGKILL the process at named durability checkpoints
 * (`failpoint-hit` committed and fsynced first), and gives the test process
 * readers and assertions for the two independent evidence streams that
 * survive: the fixture's side-effect ledger and the session JSONL logs.
 *
 * @module @deepseek-ai/dsh-durable-runtime
 */

export {
  createDurableTestRuntime,
  DURABLE_RUNTIME_BASE_ENV,
  type CreateDurableTestRuntimeOptions,
  type DurableProfileExtras,
  type DurableTestRuntime,
} from './runtime.ts'
export {
  spawnDurableHost,
  teardownDurableHosts,
  expectNoOrphanHosts,
  sessionIdFromJsonLines,
  DURABLE_HOST_TIMEOUT_MS,
  type DurableHostHandle,
  type DurableHostResult,
  type SpawnDurableHostOptions,
} from './host.ts'
export {
  readLedger,
  countByKind,
  expectSideEffectCount,
  expectFailpointHit,
} from './ledger.ts'
export {
  armFailpoint,
  disarmFailpoint,
} from './failpoint.ts'
export {
  readSessionLogFiles,
  eventTypes,
  rowsOfType,
  toolCalls,
  toolResultCallIds,
  inboxClaimCount,
  sessionIdFromHeader,
  hasUnclosedTurn,
} from './session-log.ts'
export type {
  FailpointName,
  FailpointSpec,
  LedgerEntry,
  LedgerKind,
  SessionLogFile,
  SessionLogRow,
  ToolCallRecord,
} from './types.ts'
