/**
 * The WSL world's `SubprocessRuntime`. One-shot calls run as
 * `wsl.exe -d <distro> [-u <user>] --cd <linux cwd> --exec <argv…>` through the
 * LOCAL world's subprocess provider (wsl.exe is a Windows executable, so
 * Windows-side spawn mechanics, output bounds, and tree termination stay the
 * local seam's); persistent terminals run the standalone relay script behind
 * the local PTY (see `./relay.ts`).
 *
 * Host-packaged binaries (the bundled ripgrep is today's caller) cannot run
 * inside the distribution — they are Windows executables handed Linux paths.
 * A spawn whose `argv[0]` is a host drive-absolute executable therefore falls
 * back to the local world over the 9P share: the cwd and every absolute Linux
 * path argument are translated to their UNC form. Functionally correct and
 * slower than an in-distro engine.
 *
 * TODO(world-wsl): replace the 9P host-binary fallback for the search tools
 * with an in-distro engine (GNU grep/find) once tool-fs-search grows a
 * per-world execution seam.
 *
 * @module @deepseek-ai/dsh-world-wsl/subprocess
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  isAbsoluteLinuxPath,
  isValidWslUsername,
  isWindowsPathShaped,
  joinUnc,
  parseWslUnc,
  windowsToMntPath,
} from './paths.ts'

const execFileAsync = promisify(execFile)

/** Timeout for the executable probes (`which`/`test -x`). */
const PROBE_TIMEOUT_MS = 10_000

/** The host capabilities a WSL subprocess backend consumes. */
export interface WslSubprocessDeps {
  /**
   * The local (host) world's subprocess provider: runs wsl.exe itself, the
   * relay, and host-binary fallbacks. A getter because the backend is built
   * before the composition finishes mounting.
   */
  local: () => SubprocessRuntime
  /** Absolute path of the built relay script (`lib/relay.js`). */
  relayPath: string
  /** The `wsl.exe` executable (default `wsl.exe`). */
  wslPath?: string
  /** In-distro probe for executable lookup (tests substitute a fake); default runs `wsl.exe -d <distro> --exec`. */
  probe?: (args: readonly string[], signal?: AbortSignal) => Promise<string | undefined>
}

/** Backend identity: one distribution, optionally one Linux user. */
export interface WslSubprocessConfig {
  /** The distribution every call runs in. */
  distro: string
  /** Linux user for `wsl.exe -u`; undefined = the distro default user. */
  username?: string
}

/** One translated execution plan: both worlds' coordinates plus the wsl.exe argv. */
interface WslSpawnPlan {
  /** Linux working directory handed to `wsl.exe --cd`. */
  linuxCwd: string
  /** A valid Windows directory for the `wsl.exe` process itself. */
  windowsCwd: string
}

/**
 * The WSL subprocess backend. Its own `ctx.subprocess` registration is inert —
 * the backend lives in a per-backend isolate scope and only the world registry
 * reads it.
 */
export class WslSubprocessRuntime extends SubprocessRuntime {
  constructor(
    ctx: Context,
    private readonly wslConfig: WslSubprocessConfig,
    private readonly deps: WslSubprocessDeps,
  ) {
    super(ctx)
  }

  /**
   * Translate a spec cwd into both worlds' coordinates. UNC cwds must name
   * THIS backend's distribution (a mismatch means the router misrouted);
   * Linux-absolute cwds run here by construction; drive paths are reached
   * through their `/mnt/<drive>` form.
   */
  private planCwd(cwd: string): WslSpawnPlan {
    const unc = parseWslUnc(cwd)
    if (unc !== null) {
      if (unc.distro !== this.wslConfig.distro) {
        throw new Error(`wsl-subprocess: cwd "${cwd}" belongs to distribution "${unc.distro}", not "${this.wslConfig.distro}"`)
      }
      // The `wsl.exe` process itself needs a plain Windows directory: its own
      // cwd is irrelevant (`--cd` sets the Linux side), and spawning with a
      // UNC cwd is a documented Node/Windows edge. SystemRoot always exists.
      return { linuxCwd: unc.linuxPath, windowsCwd: process.env.SystemRoot ?? process.cwd() }
    }
    if (isAbsoluteLinuxPath(cwd)) {
      return { linuxCwd: cwd, windowsCwd: process.cwd() }
    }
    const mnt = windowsToMntPath(cwd)
    if (mnt === null) {
      throw new Error(`wsl-subprocess: cwd "${cwd}" is not in the WSL execution world`)
    }
    return { linuxCwd: mnt, windowsCwd: cwd }
  }

  /**
   * Merge the caller env and inject `WSLENV` so the Windows-side values reach
   * the Linux process. Windows-path-shaped values get the `/p` translation
   * flag; the ambient `WSLENV` value is preserved and extended.
   */
  private withWslEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
    const merged: Record<string, string> = {}
    for (const [key, value] of Object.entries(env ?? {})) {
      if (value !== undefined) merged[key] = value
    }
    const flags: string[] = []
    for (const [key, value] of Object.entries(merged)) {
      if (key.toUpperCase() === 'WSLENV') continue
      flags.push(isWindowsPathShaped(value) ? `${key}/p` : key)
    }
    const ambient = process.env.WSLENV
    merged.WSLENV = [ambient, flags.join(':')].filter(part => part !== undefined && part !== '').join(':')
    return merged
  }

  /** The wsl.exe argv prefix selecting this backend's distribution and user. */
  private wslPrefix(): string[] {
    const user = this.wslConfig.username
    return [
      this.deps.wslPath ?? 'wsl.exe',
      '-d', this.wslConfig.distro,
      ...(user !== undefined && isValidWslUsername(user) ? ['-u', user] : []),
    ]
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const plan = this.planCwd(spec.cwd)
    const program = spec.argv[0]
    if (program !== undefined && /^[A-Za-z]:[\\/]/.test(program)) {
      // Host-packaged binary (the bundled ripgrep today): run it in the local
      // world over the 9P share, translating the cwd and every absolute Linux
      // path argument to their UNC form. See the module TODO for the planned
      // in-distro engine.
      return this.deps.local().spawn({
        ...spec,
        cwd: joinUnc(this.wslConfig.distro, plan.linuxCwd),
        argv: spec.argv.map(arg => (isAbsoluteLinuxPath(arg) ? joinUnc(this.wslConfig.distro, arg) : arg)),
      })
    }
    return this.deps.local().spawn({
      ...spec,
      argv: [...this.wslPrefix(), '--cd', plan.linuxCwd, '--exec', ...spec.argv],
      cwd: plan.windowsCwd,
      env: this.withWslEnv(spec.env),
    })
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const plan = this.planCwd(spec.cwd)
    const user = this.wslConfig.username
    return this.deps.local().spawnTerminal({
      ...spec,
      argv: [process.execPath, this.deps.relayPath],
      // The relay reads its process cwd for the session coordinates; both the
      // UNC form and a drive path are valid Windows cwds.
      cwd: parseWslUnc(spec.cwd) !== null ? spec.cwd : plan.windowsCwd,
      env: {
        ...spec.env,
        DSH_WSL_DISTRO: this.wslConfig.distro,
        ...(user !== undefined && isValidWslUsername(user) ? { DSH_WSL_USER: user } : {}),
      },
    })
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    void env
    if (isAbsoluteLinuxPath(command)) {
      const probe = await this.probe(['test', '-x', command], signal)
      if (probe) return command
      throw new SubprocessExecutableNotFoundError(`wsl-subprocess: "${command}" is not an executable in distribution "${this.wslConfig.distro}"`)
    }
    if (/[/\\]/.test(command)) {
      throw new SubprocessExecutableNotFoundError(`wsl-subprocess: relative command paths are rejected: "${command}"`)
    }
    const found = await this.probe(['which', '--', command], signal)
    if (found !== undefined && isAbsoluteLinuxPath(found)) return found
    throw new SubprocessExecutableNotFoundError(`wsl-subprocess: no executable "${command}" on the PATH of distribution "${this.wslConfig.distro}"`)
  }

  /** Run one short in-distro probe, returning its trimmed stdout or undefined on any failure. */
  private async probe(args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    if (this.deps.probe !== undefined) return this.deps.probe(args, signal)
    try {
      const result = await execFileAsync(
        this.deps.wslPath ?? 'wsl.exe',
        ['-d', this.wslConfig.distro, '--exec', ...args],
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, ...(signal !== undefined ? { signal } : {}) },
      )
      const out = result.stdout.trim()
      return out === '' ? undefined : out
    } catch {
      // A stopped distribution, a missing probe tool, or an abort all land here.
      return undefined
    }
  }

  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    return Promise.resolve({ platform: 'posix', defaultShell: '/bin/bash' })
  }
}
