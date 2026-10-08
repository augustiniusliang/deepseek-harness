/**
 * Spawning, killing, and orphan accounting for headless dsh hosts booted
 * against a durable test runtime. Every host launches through the shared
 * dual-mode launcher ({@link resolveExampleLaunch}), so local runs boot the
 * CLI from source under tsx and CI can boot the built artifact under plain
 * Node via `DSH_EXAMPLE_MODE=lib`.
 *
 * @module @deepseek-ai/dsh-durable-runtime/host
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { DurableTestRuntime } from './runtime.ts'

/** Default per-host deadline: failpoint scenarios must die by SIGKILL, never by this bound. */
export const DURABLE_HOST_TIMEOUT_MS = 120_000

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const dshBinScript = join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')
const tsconfigPath = join(repoRoot, 'tsconfig.json')

/** Inputs to {@link spawnDurableHost}. */
export interface SpawnDurableHostOptions {
  /** The task text; the fixture protocol keys on it (`ECHO:`, `EFFECT:`, `PARALLEL:`). */
  readonly prompt: string
  /** Adopt this persisted session instead of starting a fresh one (headless `--session-id`). */
  readonly sessionId?: string
  /** Stream the run as newline-delimited JSON events on stdout (headless `--json`). */
  readonly json?: boolean
  /** Extra environment layered over the isolated host environment. */
  readonly extraEnv?: Readonly<NodeJS.ProcessEnv>
  /** Process deadline; defaults to {@link DURABLE_HOST_TIMEOUT_MS}. */
  readonly timeoutMs?: number
}

/** Settled outcome of one host process. */
export interface DurableHostResult {
  /** Exit code, absent when a signal ended the process. */
  readonly exitCode: number | undefined
  /** Terminating signal (`SIGKILL` for failpoint hits and controller kills). */
  readonly signal: string | undefined
  /** Complete captured stdout. */
  readonly stdout: string
  /** Complete captured stderr. */
  readonly stderr: string
  /** Whether the deadline, not the scenario, ended the process. */
  readonly timedOut: boolean
}

/** One spawned host: identity, outcome, and a truthful kill. */
export interface DurableHostHandle {
  /** Operating-system process id, absent only when the spawn itself failed. */
  readonly pid: number | undefined
  /** Settles when the process exits, however it exited (`reject: false` semantics). */
  readonly result: Promise<DurableHostResult>
  /**
   * SIGKILL the host. Reports whether a signal was actually delivered: a host
   * that already exited reports `false` rather than faking a kill.
   */
  kill(): boolean
}

/** Every not-yet-settled host spawned in this process, for orphan convergence. */
const liveHosts = new Set<DurableHostHandle>()

/** Every pid ever spawned here, kept after settle so probes can prove death. */
const spawnedPids: number[] = []

/** Whether `pid` still names a live process (own children die with ESRCH on probe). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Extract the session id a `--json` run announced on stdout. Unparseable tail
 * lines (a SIGKILL can tear the final write) are skipped.
 * @param stdout - complete captured stdout of a run spawned with `json: true`.
 * @returns the announced session id, or `undefined` when the run never announced one.
 */
export function sessionIdFromJsonLines(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    try {
      const event = JSON.parse(line) as { type?: string; sessionId?: unknown }
      if (event.type === 'session' && typeof event.sessionId === 'string') return event.sessionId
    } catch {
      // A torn final line carries no session announcement; keep scanning nothing after it.
    }
  }
  return undefined
}

/**
 * Spawn one headless dsh host against `runtime` with the fixture profile.
 * Restart is spelled as a second call against the same runtime: the new host
 * shares the isolated home, sessions, control file, and ledger. The handle is
 * tracked for orphan convergence until its result settles.
 * @param runtime - the runtime the host boots against.
 * @param options - prompt, optional session adoption, environment, deadline.
 * @returns the live host handle.
 */
export function spawnDurableHost(
  runtime: DurableTestRuntime,
  options: SpawnDurableHostOptions,
): DurableHostHandle {
  const launch = resolveExampleLaunch({
    srcBin: dshBinScript,
    configArgs: [
      '--profile', 'headless',
      ...options.sessionId === undefined ? [] : ['--session-id', options.sessionId],
      ...options.json === true ? ['--json'] : [],
      options.prompt,
    ],
    tsconfigPath,
    env: {
      DSH_HOME: runtime.home,
      DSH_AGENTS_HOME: join(runtime.root, 'agents-home'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        '--disable-warning=ExperimentalWarning',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      ].filter(Boolean).join(' '),
      ...options.extraEnv,
    },
  })
  const subprocess = execa(launch.command, launch.args, {
    cwd: runtime.cwd,
    env: launch.env,
    input: '',
    timeout: options.timeoutMs ?? DURABLE_HOST_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    reject: false,
    stripFinalNewline: false,
  })
  let settled = false
  const handle: DurableHostHandle = {
    get pid(): number | undefined {
      return subprocess.pid
    },
    result: subprocess.then((outcome): DurableHostResult => {
      settled = true
      liveHosts.delete(handle)
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        timedOut: outcome.timedOut,
      }
    }),
    kill(): boolean {
      if (settled) return false
      return subprocess.kill('SIGKILL')
    },
  }
  liveHosts.add(handle)
  /* v8 ignore next -- an undefined pid means the spawn itself failed; every spec spawn succeeds */
  if (handle.pid !== undefined) spawnedPids.push(handle.pid)
  return handle
}

/**
 * SIGKILL every not-yet-settled host and await their exit. Idempotent: hosts
 * that already exited report no kill and simply settle.
 * @returns resolution once no host this process spawned remains live.
 */
export async function teardownDurableHosts(): Promise<void> {
  const survivors = [...liveHosts]
  for (const host of survivors) host.kill()
  await Promise.all(survivors.map(host => host.result))
}

/**
 * Assert no spawned host survives: every tracked handle settled and every
 * recorded pid answers dead to a `process.kill(pid, 0)` probe. A live host at
 * this point is a teardown defect and must fail the calling test. A reaped
 * pid the operating system already reassigned reads as a leak; the window is
 * documented in the README.
 * @throws When any spawned host or pid remains live.
 */
export function expectNoOrphanHosts(): void {
  const survivors = spawnedPids.filter(pid => isProcessAlive(pid))
  if (liveHosts.size > 0 || survivors.length > 0) {
    throw new Error(`durable host leak: ${String(liveHosts.size)} unsettled, pids still live: ${survivors.map(String).join(', ')}`)
  }
}
