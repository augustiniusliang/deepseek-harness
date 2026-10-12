import { afterEach, describe, expect, it } from 'vitest'
import {
  armFailpoint, createDurableTestRuntime, expectFailpointHit, readLedger,
  readSessionLogFiles, sessionIdFromHeader, spawnDurableHost, teardownDurableHosts,
  type DurableTestRuntime,
} from '../src/index.ts'
import { expectKilledBySigkill } from './helpers.ts'

const runtimes: DurableTestRuntime[] = []
afterEach(async () => {
  await teardownDurableHosts()
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

describe('repro: schedule delivery/receipt double-write window', () => {
  it('commits one delivery without an armed checkpoint', async () => {
    const runtime = await createDurableTestRuntime({ schedule: true })
    runtimes.push(runtime)
    const result = await spawnDurableHost(runtime, { prompt: 'SCHEDULE' }).result
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.exitCode, result.stderr).toBe(0)
    const ledger = await readLedger(runtime)
    const toolResults = (await readSessionLogFiles(runtime)).flatMap(file => file.rows.filter(row => row.type === 'tool/result'))
    expect(ledger.filter(row => row.kind === 'schedule-delivered'), JSON.stringify(toolResults) + result.stderr).toHaveLength(1)
    expect(ledger.filter(row => row.kind === 'schedule-committed')).toHaveLength(1)
    await expect(expectFailpointHit(runtime, 'schedule-flushed')).rejects.toThrow('expected a failpoint-hit')
  }, 120_000)

  it('delivers the same reminder twice after a kill between Session flush and task receipt', async () => {
    const runtime = await createDurableTestRuntime({ schedule: true })
    runtimes.push(runtime)
    await armFailpoint(runtime, { name: 'schedule-flushed', once: true })
    const first = await spawnDurableHost(runtime, { prompt: 'SCHEDULE' }).result
    expect(first.timedOut, first.stderr).toBe(false)
    await expectFailpointHit(runtime, 'schedule-flushed')
    expectKilledBySigkill(first)
    const files = await readSessionLogFiles(runtime)
    expect(files).toHaveLength(1)
    const sessionId = sessionIdFromHeader(files[0]!.rows)
    expect(files[0]!.rows.filter(row => row.type === 'agent/inbox/spliced'
      && JSON.stringify(row.data).includes('"kind":"schedule"'))).toHaveLength(1)
    expect((await readLedger(runtime)).filter(row => row.kind === 'schedule-committed')).toHaveLength(0)
    // Schedule owns restoration of the target; the foreground headless run only waits for its receipt.
    const resumed = await spawnDurableHost(runtime, { prompt: 'SCHEDULE:resume' }).result
    expect(resumed.timedOut, resumed.stderr).toBe(false)
    expect(resumed.exitCode, resumed.stderr).toBe(0)
    const rows = (await readSessionLogFiles(runtime)).find(file => sessionIdFromHeader(file.rows) === sessionId)!.rows
    expect(rows.filter(row => row.type === 'agent/inbox/spliced'
      && JSON.stringify(row.data).includes('"kind":"schedule"'))).toHaveLength(2)
    expect((await readLedger(runtime)).filter(row => row.kind === 'schedule-delivered')).toHaveLength(2)
    expect((await readLedger(runtime)).filter(row => row.kind === 'schedule-committed')).toHaveLength(1)
  }, 120_000)
})
