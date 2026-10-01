/**
 * The SSH world's `SubprocessRuntime`: one-shot spawns execute on the remote
 * host through the pooled shell (`bash -lc` with a remote `cd`), and every
 * persistent terminal is its own dedicated `ssh -tt` channel (one connection
 * per terminal, the upstream plugin's terminals-Map shape).
 *
 * @module @deepseek-ai/dsh-world-ssh/subprocess
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { MirrorRoot, SshProfile } from './profile.ts'
import { pathInside } from './profile.ts'
import type { SshSessionPool } from './session.ts'
import { shellQuote, shellQuotePath, sshArgv } from './ssh.ts'

/** The host capabilities the SSH subprocess backend consumes. */
export interface SshSubprocessDeps {
  /** The pooled remote command channel (spawn path). */
  pool: SshSessionPool
  /** The LOCAL world's subprocess: runs `ssh -tt` for terminals and `command -v` probes. */
  local: () => SubprocessRuntime
  /** Mirror roots for translating local mirror cwd paths to remote paths. */
  mirrorRoots: readonly MirrorRoot[]
}

/** A collected-stream reader shaped like the local provider's. */
class RemoteStreamReader {
  constructor(private readonly text: string) {}
  readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: undefined } {
    return { text: offset === 0 ? this.text : '', nextOffset: 0, lossy: false }
  }
}

/**
 * A one-shot remote command's handle: mirrors the local provider's collect-mode
 * shape so consumers (the bash tool) read the same fields.
 */
class RemoteHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly control = undefined
  readonly collected: { stdout?: RemoteStreamReader; stderr?: RemoteStreamReader }
  readonly done: Promise<SubprocessOutcome>

  constructor(run: Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>) {
    this.collected = {}
    this.done = run.then((result) => {
      this.collected.stdout = new RemoteStreamReader(result.stdout)
      this.collected.stderr = new RemoteStreamReader(result.stderr)
      return { exitCode: result.exitCode, signal: result.signal }
    })
  }

  terminate(): void {
    // The pooled session owns the remote process; dropping it is the teardown.
  }

  async waitForExit(): Promise<boolean> {
    await this.done.catch(() => false)
    return true
  }
}

/**
 * The SSH subprocess backend. `spawn` routes through the pool; `spawnTerminal`
 * opens one `ssh -tt` channel per terminal through the local world.
 */
export class SshSubprocessRuntime extends SubprocessRuntime {
  constructor(
    ctx: Context,
    private readonly profile: SshProfile,
    private readonly deps: SshSubprocessDeps,
  ) {
    super(ctx)
  }

  /** Translate a spawn cwd into a remote directory (mirror path, Linux path, or the remote root). */
  private remoteCwd(cwd: string): string {
    if (cwd.startsWith('/') || cwd.startsWith('~')) return cwd
    const mirror = this.deps.mirrorRoots.find(m => pathInside(m.root, cwd))
    if (mirror === undefined) return this.profile.remoteRoot ?? '~'
    const relative = cwd.slice(mirror.root.length).replace(/\\/g, '/').replace(/^\/+/, '')
    return posix.join(mirror.info.remotePath, relative)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const cwd = this.remoteCwd(spec.cwd)
    // One login shell per call, exactly like the world's bash tool: the profile
    // chain loads (nvm, cargo, conda), then an explicit cd pins the workdir
    // because several profiles reset cwd to $HOME. Every argv element is
    // single-quoted, so model-controlled text is never re-parsed by a shell.
    const command = spec.argv.map(arg => shellQuote(arg)).join(' ')
    const stdinData = typeof spec.stdio.stdin === 'object' ? spec.stdio.stdin.data : undefined
    const run = (async () => {
      const merged = `cd ${shellQuote(cwd)} && ${command}`
      const result = await this.deps.pool.runPooled(
        this.profile,
        `bash -lc ${shellQuote(merged)}`,
        stdinData,
        undefined,
        true,
        undefined,
      )
      return {
        exitCode: result.exitCode,
        signal: result.isTimeout === true ? 'SIGKILL' as const : null,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    })()
    return new RemoteHandle(run) as unknown as SubprocessHandle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    // One dedicated `ssh -tt` channel per terminal: the remote shell inherits
    // the PTY, and the remote cwd comes first through the remote command line.
    const cwd = this.remoteCwd(spec.cwd)
    const remoteCmd = `cd ${shellQuote(cwd)} && exec $SHELL -i`
    return this.deps.local().spawnTerminal({
      ...spec,
      argv: sshArgv(this.profile, remoteCmd, true),
      cwd: process.cwd(),
    })
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    void env
    signal?.throwIfAborted()
    if (/[/\\]/.test(command)) {
      if (!command.startsWith('/')) {
        throw new SubprocessExecutableNotFoundError(`ssh-subprocess: relative command paths are rejected: "${command}"`)
      }
      const probe = await this.deps.pool.runPooled(this.profile, `test -x ${shellQuotePath(command)} && echo ok`)
      if (probe.ok) return command
      throw new SubprocessExecutableNotFoundError(`ssh-subprocess: "${command}" is not an executable on ${this.profile.host}`)
    }
    const found = await this.deps.pool.runPooled(this.profile, `command -v -- ${shellQuote(command)}`)
    if (found.ok && found.stdout.trim() !== '') return found.stdout.trim().split('\n')[0] ?? command
    throw new SubprocessExecutableNotFoundError(`ssh-subprocess: no executable "${command}" on the PATH of ${this.profile.host}`)
  }

  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    return Promise.resolve({ platform: 'posix', defaultShell: '/bin/bash' })
  }
}
