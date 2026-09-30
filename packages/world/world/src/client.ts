/**
 * Client-namespace projection of the execution-world domain: a pure re-export
 * of the package's types outlet. Client code imports ONLY the client namespace
 * (repo discipline), so `./client` carries the same single-source projection-key
 * declaration `./types` serves to host consumers — zero duplication.
 *
 * @module @deepseek-ai/dsh-world/client
 */

export type * from './types.ts'
