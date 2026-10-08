import { afterEach, describe, expect, it } from 'vitest'
import {
  armFailpoint,
  createDurableTestRuntime,
  expectFailpointHit,
  expectNoOrphanHosts,
  expectSideEffectCount,
  readSessionLogFiles,
  sessionIdFromJsonLines,
  spawnDurableHost,
  teardownDurableHosts,
  type DurableTestRuntime,
} from '../src/index.ts'
import { expectKilledBySigkill } from './helpers.ts'

const HOST_TEST_TIMEOUT_MS = 120_000

const runtimes: DurableTestRuntime[] = []

afterEach(async () => {
  await teardownDurableHosts()
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

describe('repro: kill at the input-claim window', () => {
  it('loses the claimed input entirely: no durable trace, no resume entry', async () => {
    const runtime = await createDurableTestRuntime()
    runtimes.push(runtime)
    await armFailpoint(runtime, { name: 'input-claimed', once: true })

    // `agent/inbox/spliced` is the durable claim: the loop removed the pending
    // message from its inbox. The fixture kills the host synchronously inside
    // that event's emission — before the request assembly appended
    // `user/message`, and before any flush barrier ran.
    const host = spawnDurableHost(runtime, { prompt: 'EFFECT:claim', json: true })
    const result = await host.result
    expectKilledBySigkill(result)
    await expectFailpointHit(runtime, 'input-claimed')

    // The model was never reached and no side effect committed.
    await expectSideEffectCount(runtime, 'model-request', 0)
    await expectSideEffectCount(runtime, 'tool-effect', 0)

    // Session events route to the JSONL writer's live buffer (append is
    // best-effort; only a `session/flush` barrier is a durability point).
    // Nothing flushed before the claim, so the SIGKILL discarded the buffer:
    // the whole run — the enqueue splice, the claim splice, the session header
    // — left no durable trace at all. The claimed input is not "pending
    // somewhere"; it is gone.
    expect(await readSessionLogFiles(runtime)).toHaveLength(0)

    // Headless does have a resume entry (`--session-id`), but it adopts a
    // persisted session: with no durable log the id the run announced is
    // unknown to storage, and the resume fails instead of recreating history.
    const sessionId = sessionIdFromJsonLines(result.stdout)
    if (sessionId === undefined) throw new Error('json run announced no session id')
    const resumed = spawnDurableHost(runtime, { prompt: 'ECHO:after', sessionId })
    const resume = await resumed.result
    expect(resume.exitCode).toBe(1)
    expect(resume.stderr).toContain(`session "${sessionId}" does not exist`)
    expectNoOrphanHosts()
  }, HOST_TEST_TIMEOUT_MS)
})
