import { describe, expect, it } from 'vitest'
import { ExecutionReaders, commitSchema } from '../src/index.ts'

const current = {
  version: 1, transactionId: 'tx', epoch: 1,
  command: { id: 'cmd', payload: { uri: 'artifact:x', sha256: 'a'.repeat(64), bytes: 0, mediaType: 'text/plain' } },
  changes: [{ kind: 'run', expectedRevision: null, value: {
    version: 1, id: 'run', sessionId: 'session', projectId: 'project', owner: 'ettore',
    revision: 0, epoch: 1, state: 'queued', phase: 'admit_input', cancelGeneration: 0,
  } }], sessions: [],
}

describe('explicit execution readers', () => {
  it('reads current data without migration and detaches its output', () => {
    const readers = new ExecutionReaders()
    const result = readers.read(current)
    expect(result).toEqual(commitSchema.parse(current))
    result.changes.splice(0)
    expect(current.changes).toHaveLength(1)
  })
  it('refuses future, missing and malformed versions instead of guessing', () => {
    const readers = new ExecutionReaders()
    expect(() => readers.read({ ...current, version: 2 })).toThrow('Future')
    expect(() => readers.read({ ...current, version: 0 })).toThrow('Missing')
    expect(() => readers.read({ ...current, version: -1 })).toThrow()
    expect(() => readers.read({ ...current, extra: true })).toThrow()
  })
  it('requires a registered adjacent reader and disposes exactly that registration', () => {
    const readers = new ExecutionReaders()
    const migration = { from: 0, to: 1, migrate: () => structuredClone(current) }
    const dispose = readers.register(migration)
    expect(() => readers.register(migration)).toThrow('duplicate')
    expect(readers.read({ ...current, version: 0 })).toEqual(commitSchema.parse(current))
    dispose()
    const disposeNext = readers.register({ ...migration })
    dispose()
    expect(readers.read({ ...current, version: 0 }).version).toBe(1)
    disposeNext()
    expect(() => readers.read({ ...current, version: 0 })).toThrow('Missing')
  })
  it('rejects gaps, downgrades and a reader returning the wrong version', () => {
    const readers = new ExecutionReaders()
    for (const [from, to] of [[-1, 0], [0, 2], [1, 0], [0.5, 1.5]] as const) {
      expect(() => readers.register({ from, to, migrate: value => value })).toThrow()
    }
    readers.register({ from: 0, to: 1, migrate: value => value })
    expect(() => readers.read({ ...current, version: 0 })).toThrow('unexpected')
  })
})
