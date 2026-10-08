/**
 * Reading and asserting the fixture host's append-only side-effect ledger.
 * A ledger row is cross-process evidence: the fixture fsyncs every row before
 * any kill, so what the test process reads is what durably happened.
 *
 * @module @deepseek-ai/dsh-durable-runtime/ledger
 */

import { readFile } from 'node:fs/promises'
import type { DurableTestRuntime } from './runtime.ts'
import type { FailpointName, LedgerEntry, LedgerKind } from './types.ts'

/**
 * Parse the runtime's ledger into rows. An absent ledger (no host ever ran,
 * or no checkpoint or effect committed) reads as zero rows.
 * @param runtime - the runtime whose ledger to read.
 * @returns every ledger row in append order.
 */
export async function readLedger(runtime: DurableTestRuntime): Promise<LedgerEntry[]> {
  let content: string
  try {
    content = await readFile(runtime.ledgerFile, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return content.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as LedgerEntry)
}

/**
 * Count rows of one kind.
 * @param entries - ledger rows from {@link readLedger}.
 * @param kind - the row kind to count.
 * @returns how many rows carry that kind.
 */
export function countByKind(entries: readonly LedgerEntry[], kind: LedgerKind): number {
  return entries.filter(entry => entry.kind === kind).length
}

/**
 * Assert the ledger holds exactly `expected` rows of `kind`. Independent
 * side-effect accounting is the facility's core evidence, so a mismatch must
 * fail the calling test.
 * @param runtime - the runtime whose ledger to read.
 * @param kind - the row kind to count.
 * @param expected - the exact expected count.
 * @throws When the durable count differs from `expected`.
 */
export async function expectSideEffectCount(
  runtime: DurableTestRuntime,
  kind: LedgerKind,
  expected: number,
): Promise<void> {
  const entries = await readLedger(runtime)
  const actual = countByKind(entries, kind)
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)} ${JSON.stringify(kind)} ledger row(s), found ${String(actual)}: ${JSON.stringify(entries)}`)
  }
}

/**
 * Assert the fixture recorded a hit for failpoint `name`. A failpoint that
 * never fired is an injector defect, not a passing scenario: the absence must
 * fail the calling test.
 * @param runtime - the runtime whose ledger to read.
 * @param name - the armed failpoint expected to have fired.
 * @throws When no `failpoint-hit` row names `name`.
 */
export async function expectFailpointHit(runtime: DurableTestRuntime, name: FailpointName): Promise<void> {
  const entries = await readLedger(runtime)
  const hit = entries.some(entry => entry.kind === 'failpoint-hit' && entry.detail?.name === name)
  if (!hit) {
    throw new Error(`expected a failpoint-hit ledger row for ${JSON.stringify(name)}: ${JSON.stringify(entries)}`)
  }
}
