/**
 * Reading and reducing the session JSONL logs a host left in the runtime's
 * persistence root. Durable logs never contain interrupted-turn closers: a
 * resuming reader derives those in memory (see
 * `interruptedTurnClosers` in `@deepseek-ai/dsh-session`), so
 * {@link hasUnclosedTurn} reports the tail a repair would close rather than
 * searching the file for closer rows.
 *
 * @module @deepseek-ai/dsh-durable-runtime/session-log
 */

import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { DurableTestRuntime } from './runtime.ts'
import type { SessionLogFile, SessionLogRow, ToolCallRecord } from './types.ts'

/**
 * Parse every `*.jsonl` session log under the runtime's persistence root. An
 * absent root (no host ever ran) reads as zero files.
 * @param runtime - the runtime whose session logs to read.
 * @returns one entry per log file, rows in file order.
 */
export async function readSessionLogFiles(runtime: DurableTestRuntime): Promise<SessionLogFile[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(runtime.sessionsDir, { recursive: true, withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: SessionLogFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const path = join(entry.parentPath, entry.name)
    const content = await readFile(path, 'utf8')
    const rows = content.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as SessionLogRow)
    files.push({ path, rows })
  }
  return files
}

/**
 * Reduce rows to their event-type sequence.
 * @param rows - rows of one session log.
 * @returns every row's `type`, in file order.
 */
export function eventTypes(rows: readonly SessionLogRow[]): string[] {
  return rows.map(row => row.type)
}

/**
 * Select rows of one event type.
 * @param rows - rows of one session log.
 * @param type - the session event type to select.
 * @returns the matching rows, in file order.
 */
export function rowsOfType(rows: readonly SessionLogRow[], type: string): SessionLogRow[] {
  return rows.filter(row => row.type === type)
}

/**
 * Reduce `tool/call` rows to their pairing identities.
 * @param rows - rows of one session log.
 * @returns call id and tool name of every recorded tool intent, in file order.
 */
export function toolCalls(rows: readonly SessionLogRow[]): ToolCallRecord[] {
  return rowsOfType(rows, 'tool/call').map((row) => {
    const data = row.data as { callId: string; name: string }
    return { callId: data.callId, name: data.name }
  })
}

/**
 * Reduce `tool/result` rows to the call ids they settle.
 * @param rows - rows of one session log.
 * @returns the settled call ids, in file order.
 */
export function toolResultCallIds(rows: readonly SessionLogRow[]): string[] {
  return rowsOfType(rows, 'tool/result').map((row) => {
    const data = row.data as { message: { toolCallId: string } }
    return data.message.toolCallId
  })
}

/**
 * Count durable input claims: `agent/inbox/spliced` rows that removed pending
 * input. The enqueue splice only inserts, so it does not count.
 * @param rows - rows of one session log.
 * @returns how many claim splices the log records.
 */
export function inboxClaimCount(rows: readonly SessionLogRow[]): number {
  return rowsOfType(rows, 'agent/inbox/spliced').filter((row) => {
    const data = row.data as { removedCount?: number }
    return (data.removedCount ?? 0) > 0
  }).length
}

/**
 * Read the session id off a log's header row.
 * @param rows - rows of one session log; the first must be the `session` header.
 * @returns the session id the header records.
 * @throws When the header row carries no string id.
 */
export function sessionIdFromHeader(rows: readonly SessionLogRow[]): string {
  const header: (SessionLogRow & { id?: unknown }) | undefined = rows[0]
  if (header?.type !== 'session' || typeof header.id !== 'string') {
    throw new Error(`session log header row carries no string id: ${JSON.stringify(header)}`)
  }
  return header.id
}

/**
 * Whether the log's last `turn/start` never reached its `turn/end` — the
 * interrupted tail a resuming reader closes with synthesized events rather
 * than anything the durable file itself records.
 * @param rows - rows of one session log.
 * @returns true when a turn opened and never closed.
 */
export function hasUnclosedTurn(rows: readonly SessionLogRow[]): boolean {
  const lastStart = rows.findLastIndex(row => row.type === 'turn/start')
  if (lastStart < 0) return false
  return rows.findLastIndex(row => row.type === 'turn/end') < lastStart
}
