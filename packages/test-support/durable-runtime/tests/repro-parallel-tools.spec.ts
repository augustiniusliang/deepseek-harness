import { afterEach, describe, expect, it } from 'vitest'
import {
  armFailpoint,
  createDurableTestRuntime,
  eventTypes,
  expectFailpointHit,
  expectNoOrphanHosts,
  expectSideEffectCount,
  hasUnclosedTurn,
  readLedger,
  readSessionLogFiles,
  sessionIdFromHeader,
  spawnDurableHost,
  teardownDurableHosts,
  toolCalls,
  toolResultCallIds,
  type DurableTestRuntime,
} from '../src/index.ts'
import { expectKilledBySigkill } from './helpers.ts'

const HOST_TEST_TIMEOUT_MS = 120_000

const runtimes: DurableTestRuntime[] = []

afterEach(async () => {
  await teardownDurableHosts()
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

describe('repro: tool effects before ordered receipts', () => {
  it('settles B while A is blocked, then publishes results in model order without a kill', async () => {
    const runtime = await createDurableTestRuntime()
    runtimes.push(runtime)
    const result = await spawnDurableHost(runtime, { prompt: 'BARRIER' }).result
    expect(result.timedOut).toBe(false)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe('DONE:BARRIER\n')
    const ledger = await readLedger(runtime)
    expect(ledger.filter(entry => entry.kind !== 'model-request').map(entry => `${entry.kind}:${entry.detail?.name}`)).toEqual([
      'tool-started:A', 'tool-started:B', 'tool-effect:B', 'tool-settled:B', 'tool-effect:A',
    ])
    const rows = (await readSessionLogFiles(runtime))[0]!.rows
    expect(toolResultCallIds(rows)).toEqual(toolCalls(rows).map(call => call.callId))
    await expect(expectFailpointHit(runtime, 'tool-settled')).rejects.toThrow('expected a failpoint-hit')
  }, HOST_TEST_TIMEOUT_MS)

  it('loses the successful B outcome when killed before blocked A completes', async () => {
    const runtime = await createDurableTestRuntime()
    runtimes.push(runtime)
    await armFailpoint(runtime, { name: 'tool-settled', once: true, match: { tool: 'B' } })
    const killed = await spawnDurableHost(runtime, { prompt: 'BARRIER' }).result
    expectKilledBySigkill(killed)
    await expectFailpointHit(runtime, 'tool-settled')
    expect((await readLedger(runtime)).map(entry => `${entry.kind}:${entry.detail?.name ?? ''}`)).toEqual([
      'model-request:', 'tool-started:A', 'tool-started:B', 'tool-effect:B',
      'tool-settled:B', 'failpoint-hit:tool-settled',
    ])
    const files = await readSessionLogFiles(runtime)
    expect(files).toHaveLength(1)
    const rows = files[0]!.rows
    const calls = toolCalls(rows)
    expect(calls).toHaveLength(2)
    expect(toolResultCallIds(rows)).toEqual([])
    const resumed = await spawnDurableHost(runtime, { prompt: 'ECHO:after', sessionId: sessionIdFromHeader(rows) }).result
    expect(resumed.timedOut).toBe(false)
    expect(resumed.exitCode, resumed.stderr).toBe(0)
    const after = (await readSessionLogFiles(runtime))[0]!.rows
    expect(toolResultCallIds(after)).toEqual(calls.map(call => call.callId))
    expect(after.filter(row => row.type === 'tool/result').every(row => JSON.stringify(row.data).includes('outcome is unknown'))).toBe(true)
    expect((await readLedger(runtime)).filter(entry => entry.kind === 'tool-effect').map(entry => entry.detail?.name)).toEqual(['B'])
    expectNoOrphanHosts()
  }, HOST_TEST_TIMEOUT_MS)

  it('records B’s durable effect without its receipt; resume persists an unknown-outcome repair', async () => {
    const runtime = await createDurableTestRuntime()
    runtimes.push(runtime)
    await armFailpoint(runtime, { name: 'external-effect', once: true, match: { tool: 'B' } })

    // Calls without a concurrency-safe declaration remain exclusive.
    const host = spawnDurableHost(runtime, { prompt: 'PARALLEL:A:4000:B:10' })
    const result = await host.result
    expectKilledBySigkill(result)
    await expectFailpointHit(runtime, 'external-effect')

    // The ledger is the independent side-effect account: both effects
    // committed, A strictly before B, and the hit immediately after B.
    const ledger = await readLedger(runtime)
    expect(ledger.map(entry => `${entry.kind}:${entry.detail?.name ?? ''}`)).toEqual([
      'model-request:',
      'tool-effect:A',
      'tool-effect:B',
      'failpoint-hit:external-effect',
    ])
    await expectSideEffectCount(runtime, 'model-request', 1)
    await expectSideEffectCount(runtime, 'tool-effect', 2)

    // The durable log: both intents (`tool/call`) persisted, but only A's
    // receipt. Results commit per call as each settles — NOT batched after
    // all parallel calls settle — so B's receipt is exactly what the kill took.
    const files = await readSessionLogFiles(runtime)
    expect(files).toHaveLength(1)
    const rows = files[0]!.rows
    const calls = toolCalls(rows)
    expect(calls.map(call => call.name)).toEqual(['durable_effect', 'durable_effect'])
    expect(toolResultCallIds(rows)).toEqual([calls[0]!.callId])
    expect(eventTypes(rows)).not.toContain('turn/end')
    expect(hasUnclosedTurn(rows)).toBe(true)
    const sessionId = sessionIdFromHeader(rows)

    // Resume (`--session-id`) repairs the interrupted call: a persisted
    // `tool/result` for B's callId marks the outcome unknown — while the
    // ledger above proves the effect DID commit. Receipt and effect diverge;
    // the model is told to verify externally before retrying.
    const resumed = spawnDurableHost(runtime, { prompt: 'ECHO:after', sessionId })
    const resume = await resumed.result
    expect(resume.exitCode).toBe(0)
    expect(resume.stdout).toBe('after\n')
    const after = (await readSessionLogFiles(runtime))[0]!.rows
    const repair = after.find((row) => {
      if (row.type !== 'tool/result') return false
      const data = row.data as { message: { toolCallId: string; isError?: boolean; content: { type: string; text: string }[] } }
      return data.message.toolCallId === calls[1]!.callId
    })
    expect(repair).toBeDefined()
    const repairMessage = (repair!.data as { message: { isError?: boolean; content: { text: string }[] } }).message
    expect(repairMessage.isError).toBe(true)
    expect(repairMessage.content[0]!.text).toContain('outcome is unknown')
    // The repair ran no tool body: B's effect stayed exactly once.
    await expectSideEffectCount(runtime, 'tool-effect', 2)
    expectNoOrphanHosts()
  }, HOST_TEST_TIMEOUT_MS)
})
