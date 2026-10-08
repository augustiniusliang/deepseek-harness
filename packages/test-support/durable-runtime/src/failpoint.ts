/**
 * Arming and disarming the fixture host's failpoint control file. The fixture
 * re-reads the file at every checkpoint, so an arm takes effect on the next
 * checkpoint the running host reaches; atomic tmp-plus-rename writes keep the
 * host from ever observing a torn control file.
 *
 * @module @deepseek-ai/dsh-durable-runtime/failpoint
 */

import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DurableTestRuntime } from './runtime.ts'
import type { FailpointSpec } from './types.ts'

/**
 * Arm one failpoint atomically: write the control JSON to a sibling temporary
 * file, then rename it over the control file. The fixture reads committed
 * states only.
 * @param runtime - the runtime whose control file to write.
 * @param spec - the failpoint to arm.
 */
export async function armFailpoint(runtime: DurableTestRuntime, spec: FailpointSpec): Promise<void> {
  const temporary = join(runtime.controlDir, `failpoint.${String(process.pid)}.tmp`)
  await writeFile(temporary, `${JSON.stringify(spec)}\n`)
  await rename(temporary, runtime.controlFile)
}

/**
 * Disarm every failpoint by removing the control file. Absent is the disarmed
 * state, so disarming an unarmed runtime succeeds.
 * @param runtime - the runtime whose control file to remove.
 */
export async function disarmFailpoint(runtime: DurableTestRuntime): Promise<void> {
  await rm(runtime.controlFile, { force: true })
}
