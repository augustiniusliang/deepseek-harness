import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createDurableTestRuntime, spawnDurableHost, teardownDurableHosts, expectNoOrphanHosts,
  type DurableTestRuntime,
} from '@deepseek-ai/dsh-durable-runtime'
import { receiptSchema } from '../src/index.ts'

const runtimes: DurableTestRuntime[] = []
afterEach(async () => {
  await teardownDurableHosts()
  expectNoOrphanHosts()
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
})

it('loads a provider and injected consumer in a real isolated headless host', async () => {
  const runtime = await createDurableTestRuntime({ profileExtras: {
    dependencies: { '@deepseek-ai/dsh-execution': 'workspace:*' },
  } })
  runtimes.push(runtime)
  const output = join(runtime.root, 'execution-result.json')
  const provider = new URL('./fixtures/provider.mjs', import.meta.url).href
  const consumer = new URL('./fixtures/consumer.mjs', import.meta.url).href
  await appendFile(join(runtime.home, 'profiles/headless/cordis.patch.yml'), [
    '- insert:', '    - id: execution-reference', `      name: '${provider}'`,
    '    - id: execution-consumer', `      name: '${consumer}'`,
    '      config:', `        output: '${output}'`, '',
  ].join('\n'))
  const host = await spawnDurableHost(runtime, { prompt: 'ECHO:execution-contract' }).result
  expect(host.timedOut, host.stderr).toBe(false)
  expect(host.exitCode, host.stderr).toBe(0)
  const result = z.strictObject({ first: receiptSchema, duplicate: receiptSchema, queried: receiptSchema })
    .parse(JSON.parse(await readFile(output, 'utf8')))
  expect(result.first.durability).toBe('volatile')
  expect(result.duplicate).toEqual(result.first)
  expect(result.queried).toEqual(result.first)
}, 120_000)
