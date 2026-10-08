/**
 * Shared types for the durable-runtime fault-injection facility. Types only —
 * no runtime code lives here.
 *
 * @module @deepseek-ai/dsh-durable-runtime/types
 */

/** Checkpoint names the fixture host plugin understands — the public API of the facility. */
export type FailpointName =
  | 'input-accepted'
  | 'input-claimed'
  | 'model-settled'
  | 'dispatch-intent'
  | 'external-effect'
  | 'receipt-stored'
  | 'outbox-delivered'

/** One armed failpoint, written atomically to the runtime's control file. */
export interface FailpointSpec {
  /** Checkpoint that kills the host when reached. */
  readonly name: FailpointName
  /** Delete the control file on the first hit so a restarted host does not re-trigger. */
  readonly once?: boolean
  /** Optional restriction: only fire for this `durable_effect` call `name` argument. */
  readonly match?: { readonly tool?: string }
}

/** Ledger row kinds the fixture host plugin can append. */
export type LedgerKind = 'model-request' | 'tool-effect' | 'failpoint-hit'

/**
 * One append-only ledger row, durable once visible: the fixture opens the
 * ledger, writes the row, fsyncs, and closes before any kill.
 */
export interface LedgerEntry {
  /** What the row accounts. */
  readonly kind: LedgerKind
  /** Host wall-clock milliseconds when the row was written. */
  readonly at: number
  /** Kind-specific payload; `failpoint-hit` and `tool-effect` carry `name`. */
  readonly detail?: { readonly name?: string }
}

/** One parsed row of a session JSONL log, structurally typed at the file boundary. */
export interface SessionLogRow {
  /** Session event type (`user/message`, `tool/call`, …); the header row uses `session`. */
  readonly type: string
  /** Event payload, when the row carries one. */
  readonly data?: unknown
}

/** One session JSONL file read from the runtime's persistence root. */
export interface SessionLogFile {
  /** Absolute path of the parsed file. */
  readonly path: string
  /** Every non-empty line, parsed in file order. */
  readonly rows: SessionLogRow[]
}

/** One `tool/call` session event reduced to its pairing identity. */
export interface ToolCallRecord {
  /** Call id that pairs with the matching `tool/result`. */
  readonly callId: string
  /** Registered tool name the model invoked. */
  readonly name: string
}
