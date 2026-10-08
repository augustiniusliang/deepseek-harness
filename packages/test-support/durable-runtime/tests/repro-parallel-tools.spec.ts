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

describe('repro: kill after the second parallel tool effect commits', () => {
  it('records B’s durable effect without its receipt; resume persists an unknown-outcome repair', async () => {
    const runtime = await createDurableTestRuntime()
    runtimes.push(runtime)
    await armFailpoint(runtime, { name: 'external-effect', once: true, match: { tool: 'B' } })

    // OBSERVED current behavior, contrary to the naive parallel-reading:
    // tool calls from one assistant message dispatch SERIALLY in model order.
    // A (delayMs 4000) settles completely — effect and `tool/result` — before
    // B (delayMs 10) starts, so the kill inside B's body lands after A's
    // receipt, not "before A finishes".
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
