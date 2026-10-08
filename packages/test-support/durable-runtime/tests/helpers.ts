import { expect } from 'vitest'
import type { DurableHostResult } from '../src/host.ts'

/**
 * Assert the host died from a failpoint or controller SIGKILL, not from a
 * startup failure or the deadline. Two truthful shapes exist: a controller
 * kill through execa reports signal `SIGKILL` on every platform, while the
 * fixture's self-SIGKILL is emulated with `TerminateProcess` on Windows and
 * reports exit code 1 with no signal. The ledger's `failpoint-hit` row is the
 * kill's own proof; this helper pins the process-level shape beside it.
 */
export function expectKilledBySigkill(result: DurableHostResult): void {
  expect(result.timedOut).toBe(false)
  if (result.signal === 'SIGKILL') return
  if (process.platform === 'win32' && result.exitCode === 1 && result.signal === undefined) return
  expect(
    { exitCode: result.exitCode, signal: result.signal },
    'host was neither SIGKILLed by the controller nor self-killed at a failpoint',
  ).toEqual(process.platform === 'win32' ? { exitCode: 1, signal: undefined } : { exitCode: undefined, signal: 'SIGKILL' })
}
