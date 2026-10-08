import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  armFailpoint,
  countByKind,
  createDurableTestRuntime,
  disarmFailpoint,
  DURABLE_RUNTIME_BASE_ENV,
  eventTypes,
  expectFailpointHit,
  expectNoOrphanHosts,
  expectSideEffectCount,
  hasUnclosedTurn,
  inboxClaimCount,
  readLedger,
  readSessionLogFiles,
  rowsOfType,
  sessionIdFromHeader,
  sessionIdFromJsonLines,
  spawnDurableHost,
  teardownDurableHosts,
  toolCalls,
  toolResultCallIds,
  type CreateDurableTestRuntimeOptions,
  type DurableTestRuntime,
  type SessionLogRow,
} from '../src/index.ts'
import { expectKilledBySigkill } from './helpers.ts'

const HOST_TEST_TIMEOUT_MS = 120_000

const runtimes: DurableTestRuntime[] = []

async function makeRuntime(options?: CreateDurableTestRuntimeOptions): Promise<DurableTestRuntime> {
  const runtime = await createDurableTestRuntime(options)
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  await teardownDurableHosts()
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

afterAll(() => {
  expectNoOrphanHosts()
})

describe('durable-runtime facility', () => {
  it('boots a normal run and records consistent evidence', async () => {
    const runtime = await makeRuntime()
    const host = spawnDurableHost(runtime, { prompt: 'ECHO:hello' })
    const result = await host.result
    expect(result.timedOut).toBe(false)
    expect({ exitCode: result.exitCode, signal: result.signal }).toEqual({ exitCode: 0, signal: undefined })
    expect(result.stdout).toBe('hello\n')

    const ledger = await readLedger(runtime)
    expect(ledger).toHaveLength(1)
    expect(countByKind(ledger, 'model-request')).toBe(1)
    await expectSideEffectCount(runtime, 'model-request', 1)
    await expectSideEffectCount(runtime, 'tool-effect', 0)
    await expectSideEffectCount(runtime, 'failpoint-hit', 0)

    const files = await readSessionLogFiles(runtime)
    expect(files).toHaveLength(1)
    const rows = files[0]!.rows
    const types = eventTypes(rows)
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
    expect(rowsOfType(rows, 'user/message').some(row => JSON.stringify(row.data).includes('ECHO:hello'))).toBe(true)
    expect(hasUnclosedTurn(rows)).toBe(false)
    expect(sessionIdFromHeader(rows)).toMatch(/^session-/u)
  }, HOST_TEST_TIMEOUT_MS)

  it('kills the host at an armed failpoint and restarts against the same runtime', async () => {
    const runtime = await makeRuntime()
    await armFailpoint(runtime, { name: 'model-settled', once: true })
    const killed = spawnDurableHost(runtime, { prompt: 'EFFECT:x' })
    const result = await killed.result
    expectKilledBySigkill(result)

    // The kill landed after the first model response settled but before the
    // tool dispatch: the hit and the request are accounted, the effect is not.
    await expectFailpointHit(runtime, 'model-settled')
    await expectSideEffectCount(runtime, 'model-request', 1)
    await expectSideEffectCount(runtime, 'tool-effect', 0)
    // `once` removed the control file before the kill, so a restart cannot re-trigger.
    expect(existsSync(runtime.controlFile)).toBe(false)

    const files = await readSessionLogFiles(runtime)
    expect(files).toHaveLength(1)
    const rows = files[0]!.rows
    expect(eventTypes(rows)).not.toContain('assistant/message')
    expect(hasUnclosedTurn(rows)).toBe(true)

    // Restart: a fresh host against the same isolated data works and shares
    // the ledger, proving the kill left the runtime consistent.
    const restarted = spawnDurableHost(runtime, { prompt: 'ECHO:restart' })
    const restart = await restarted.result
    expect(restart.exitCode).toBe(0)
    expect(restart.stdout).toBe('restart\n')
    await expectSideEffectCount(runtime, 'model-request', 2)
    expect(await readSessionLogFiles(runtime)).toHaveLength(2)
  }, HOST_TEST_TIMEOUT_MS)

  it('fails the calling test when an expected failpoint never fired', async () => {
    const runtime = await makeRuntime()
    await expect(expectFailpointHit(runtime, 'external-effect')).rejects.toThrow(/failpoint-hit/u)
  })

  it('reports a kill on an already-exited host as not killed', async () => {
    const runtime = await makeRuntime()
    const host = spawnDurableHost(runtime, {
      prompt: 'ECHO:bye',
      timeoutMs: 90_000,
      extraEnv: { DURABLE_FACILITY_MARK: '1' },
    })
    const result = await host.result
    expect(result.exitCode).toBe(0)
    expect(host.kill()).toBe(false)
  }, HOST_TEST_TIMEOUT_MS)

  it('isolates concurrent runtimes completely', async () => {
    const first = await makeRuntime()
    const second = await makeRuntime()
    expect(first.root).not.toBe(second.root)
    const hostA = spawnDurableHost(first, { prompt: 'ECHO:alpha' })
    const hostB = spawnDurableHost(second, { prompt: 'ECHO:beta' })
    expect(hostA.pid).toBeDefined()
    expect(hostB.pid).toBeDefined()
    expect(hostA.pid).not.toBe(hostB.pid)
    const [resultA, resultB] = await Promise.all([hostA.result, hostB.result])
    expect(resultA.exitCode).toBe(0)
    expect(resultB.exitCode).toBe(0)
    expect(resultA.stdout).toBe('alpha\n')
    expect(resultB.stdout).toBe('beta\n')
    await expectSideEffectCount(first, 'model-request', 1)
    await expectSideEffectCount(second, 'model-request', 1)
    expect((await readLedger(first)).map(entry => entry.kind))
      .toEqual((await readLedger(second)).map(entry => entry.kind))
    expect(await readSessionLogFiles(first)).toHaveLength(1)
    expect(await readSessionLogFiles(second)).toHaveLength(1)
  }, HOST_TEST_TIMEOUT_MS)

  it('kills a live host truthfully and converges orphan accounting', async () => {
    const runtime = await makeRuntime()
    const host = spawnDurableHost(runtime, { prompt: 'PARALLEL:A:8000:B:10' })
    // A live host is an orphan until it settles: the assertion must throw.
    expect(() => { expectNoOrphanHosts() }).toThrow(/durable host leak/u)
    expect(host.kill()).toBe(true)
    // Teardown itself SIGKILLs and awaits the still-live host.
    await teardownDurableHosts()
    const result = await host.result
    expectKilledBySigkill(result)
    expect(() => { expectNoOrphanHosts() }).not.toThrow()
  }, HOST_TEST_TIMEOUT_MS)
})

describe('durable-runtime readers and control edges', () => {
  it('reads absent evidence as empty and rejects mismatched counts', async () => {
    const runtime = await makeRuntime({ profileExtras: { bundles: [], dependencies: {} } })
    expect(await readLedger(runtime)).toEqual([])
    expect(await readSessionLogFiles(runtime)).toEqual([])
    await expect(expectSideEffectCount(runtime, 'model-request', 1)).rejects.toThrow(/expected 1/u)
    await armFailpoint(runtime, { name: 'input-claimed' })
    expect(existsSync(runtime.controlFile)).toBe(true)
    await disarmFailpoint(runtime)
    expect(existsSync(runtime.controlFile)).toBe(false)
    await disarmFailpoint(runtime)
  })

  it('propagates non-ENOENT read failures instead of reading them as empty', async () => {
    const runtime = await makeRuntime()
    await mkdir(runtime.ledgerFile)
    await expect(readLedger(runtime)).rejects.toThrow()
    await writeFile(runtime.sessionsDir, 'not a directory')
    await expect(readSessionLogFiles(runtime)).rejects.toThrow()
  })

  it('parses only session JSONL files from the persistence root', async () => {
    const runtime = await makeRuntime()
    await mkdir(join(runtime.sessionsDir, 'nested'), { recursive: true })
    const rows = [
      { type: 'session', id: 'session-fake' },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } },
    ]
    await writeFile(join(runtime.sessionsDir, 'nested', 'session.v4.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
    await writeFile(join(runtime.sessionsDir, 'nested', 'notes.txt'), 'ignored')
    const files = await readSessionLogFiles(runtime)
    expect(files).toHaveLength(1)
    expect(files[0]!.rows).toHaveLength(2)
    expect(sessionIdFromHeader(files[0]!.rows)).toBe('session-fake')
  })

  it('reduces synthetic rows without a host', () => {
    const rows: SessionLogRow[] = [
      { type: 'turn/start' },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [] } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'tool/call', data: { callId: 'c-1', name: 'durable_effect' } },
      { type: 'tool/result', data: { message: { toolCallId: 'c-1' } } },
    ]
    expect(eventTypes(rows)).toHaveLength(5)
    expect(rowsOfType(rows, 'turn/start')).toHaveLength(1)
    expect(inboxClaimCount(rows)).toBe(1)
    expect(toolCalls(rows)).toEqual([{ callId: 'c-1', name: 'durable_effect' }])
    expect(toolResultCallIds(rows)).toEqual(['c-1'])
    expect(hasUnclosedTurn(rows)).toBe(true)
    expect(hasUnclosedTurn([])).toBe(false)
    expect(() => sessionIdFromHeader(rows)).toThrow(/no string id/u)
    expect(sessionIdFromJsonLines('{"type":"session","sessionId":"s-1"}\n')).toBe('s-1')
    expect(sessionIdFromJsonLines('\n{"type":"other"}\ntorn-line')).toBeUndefined()
  })

  it('honors DURABLE_RUNTIME_BASE for runtime placement', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-durable-base-'))
    try {
      process.env[DURABLE_RUNTIME_BASE_ENV] = base
      const runtime = await makeRuntime()
      expect(runtime.root.startsWith(base)).toBe(true)
    } finally {
      delete process.env.DURABLE_RUNTIME_BASE
      await rm(base, { recursive: true, force: true })
    }
  })
})
