/** Version readers admit only explicitly registered adjacent migrations into protocol v1. */
import { z } from 'zod'
import { commitSchema, EXECUTION_PROTOCOL_VERSION } from './schema.ts'
import type { CommitBatch } from './types.ts'

/** Pure adjacent data migration; it must not dispatch work or edit its input. */
export interface ExecutionMigration {
  /** Source execution protocol version. */
  readonly from: number
  /** Adjacent target version; downgrades and gaps are rejected. */
  readonly to: number
  /** Translate detached JSON while preserving identity.
   * @param value - Source-version value.
   * @returns Data containing the declared target version.
   */
  migrate(value: unknown): unknown
}

/** Explicit readers never fall back to a different generation after validation fails. */
export class ExecutionReaders {
  private readonly migrations = new Map<number, ExecutionMigration>()
  /** Register one adjacent migration; callers tie the returned disposer to their plugin effect.
   * @param migration - Pure source-to-target descriptor.
   * @returns A disposer removing only this registration.
   */
  register(migration: ExecutionMigration): () => void {
    if (!Number.isSafeInteger(migration.from) || migration.from < 0
      || migration.to !== migration.from + 1 || migration.to > EXECUTION_PROTOCOL_VERSION
      || this.migrations.has(migration.from)) throw new Error('Unsupported or duplicate execution migration')
    this.migrations.set(migration.from, migration)
    return () => {
      if (this.migrations.get(migration.from) === migration) this.migrations.delete(migration.from)
    }
  }
  /** Read exact current JSON or an explicitly supported predecessor.
   * @param raw - Untrusted stored or wire data.
   * @returns The admitted current commit batch.
   */
  read(raw: unknown): CommitBatch {
    let value: unknown = structuredClone(raw)
    let version = this.version(value)
    if (version > EXECUTION_PROTOCOL_VERSION) throw new Error('Future execution protocol version')
    while (version < EXECUTION_PROTOCOL_VERSION) {
      const migration = this.migrations.get(version)
      if (migration === undefined) throw new Error('Missing execution migration')
      value = migration.migrate(value)
      version = this.version(value)
      if (version !== migration.to) throw new Error('Migration produced an unexpected execution version')
    }
    return commitSchema.parse(value)
  }
  private version(value: unknown): number {
    return z.object({ version: z.number().int().nonnegative() }).parse(value).version
  }
}
