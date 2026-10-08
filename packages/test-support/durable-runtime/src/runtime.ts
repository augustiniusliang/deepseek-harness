/**
 * Isolated per-test runtime: one exclusive temporary directory carrying the
 * DSH home, process cwd, failpoint control file, and side-effect ledger for
 * one test, plus the headless profile that mounts the fixture host plugin.
 *
 * @module @deepseek-ai/dsh-durable-runtime/runtime
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Environment override for the parent directory every runtime is created under. */
export const DURABLE_RUNTIME_BASE_ENV = 'DURABLE_RUNTIME_BASE'

/** Absolute paths of one durable test runtime. */
export interface DurableTestRuntime {
  /** Exclusive temporary directory owning everything below. */
  readonly root: string
  /** `DSH_HOME` for spawned hosts. */
  readonly home: string
  /** Process cwd for spawned hosts. */
  readonly cwd: string
  /** Directory of the failpoint control file the fixture reads. */
  readonly controlDir: string
  /** Directory of the append-only side-effect ledger the fixture writes. */
  readonly ledgerDir: string
  /** Absolute path of the armed failpoint control file. */
  readonly controlFile: string
  /** Absolute path of the side-effect ledger. */
  readonly ledgerFile: string
  /** Session persistence root configured into the profile. */
  readonly sessionsDir: string
  /**
   * Remove the whole runtime directory. Every host spawned against it must be
   * dead first; removal failure surfaces to the calling test.
   */
  dispose(): Promise<void>
}

/** Optional profile additions for compositions that need more than the base headless bundles. */
export interface DurableProfileExtras {
  /** Extra bundle package names appended after the base headless bundles. */
  readonly bundles?: readonly string[]
  /** Extra resolver-manifest dependencies (bundle packages the bundles list names). */
  readonly dependencies?: Readonly<Record<string, string>>
}

/** Inputs to {@link createDurableTestRuntime}. */
export interface CreateDurableTestRuntimeOptions {
  /** Extra bundles and dependencies merged into the generated headless profile. */
  readonly profileExtras?: DurableProfileExtras
}

const fixturePluginUrl = pathToFileURL(fileURLToPath(
  new URL('../fixtures/durable-fixture.mjs', import.meta.url),
)).href

/**
 * Create one exclusive runtime directory and write the headless profile that
 * disables the real provider, pins uncompressed JSONL session persistence
 * under the runtime, and inserts the fixture host plugin by absolute file URL.
 * The profile's failpoint starts disarmed: no control file exists until
 * `armFailpoint` writes one.
 * @param options - optional profile extras for richer compositions.
 * @returns the runtime paths plus its disposal.
 */
export async function createDurableTestRuntime(
  options: CreateDurableTestRuntimeOptions = {},
): Promise<DurableTestRuntime> {
  const root = await mkdtemp(join(process.env[DURABLE_RUNTIME_BASE_ENV] ?? tmpdir(), 'dsh-durable-'))
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  const controlDir = join(root, 'control')
  const ledgerDir = join(root, 'ledger')
  const sessionsDir = join(home, 'sessions')
  const profileDir = join(home, 'profiles', 'headless')
  await mkdir(profileDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(controlDir, { recursive: true })
  await mkdir(ledgerDir, { recursive: true })
  const extras = options.profileExtras
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-headless',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-base': 'workspace:^',
      '@deepseek-ai/dsh-headless': 'workspace:^',
      ...extras?.dependencies,
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-headless',
          ...extras?.bundles ?? [],
        ],
      },
    },
  }, undefined, 2)}\n`)
  await writeFile(join(profileDir, 'cordis.patch.yml'), [
    '- id: llm-deepseek',
    '  disabled: true',
    // Title generation would spend a second deterministic model request on the
    // fixture adapter; the run under test owns the only request.
    '- id: session-title-llm',
    '  disabled: true',
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: '${sessionsDir}'`,
    '    compression: none',
    '- insert:',
    '    - id: durable-fixture',
    `      name: '${fixturePluginUrl}'`,
    '      config:',
    `        runtime: '${root}'`,
    '',
  ].join('\n'))
  return {
    root,
    home,
    cwd,
    controlDir,
    ledgerDir,
    controlFile: join(controlDir, 'failpoint.json'),
    ledgerFile: join(ledgerDir, 'effects.jsonl'),
    sessionsDir,
    async dispose() {
      await rm(root, { recursive: true, force: true })
    },
  }
}
