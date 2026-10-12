import { writeFile } from 'node:fs/promises'
import { commitSchema } from '@deepseek-ai/dsh-execution'

export const name = 'execution-contract-consumer'
export const inject = ['execution']

export async function apply(ctx, config) {
  const batch = commitSchema.parse({
    version: 1, transactionId: 'loader-tx', epoch: 1,
    command: { id: 'loader-command', payload: {
      uri: 'artifact:loader', sha256: 'a'.repeat(64), bytes: 0, mediaType: 'text/plain',
    } },
    changes: [{ kind: 'run', expectedRevision: null, value: {
      version: 1, id: 'loader-run', sessionId: 'loader-session', projectId: 'loader-project',
      owner: 'ettore', revision: 0, epoch: 1, state: 'queued', phase: 'admit_input', cancelGeneration: 0,
    } }], sessions: [],
  })
  const first = await ctx.execution.commit(batch)
  const duplicate = await ctx.execution.commit(batch)
  const queried = await ctx.execution.receipt(batch.transactionId)
  await writeFile(config.output, JSON.stringify({ first, duplicate, queried }))
}
