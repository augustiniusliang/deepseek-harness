/**
 * Persistent-shell relay for WSL sessions.
 *
 * The WSL world's `spawnTerminal` spawns THIS script as a plain local Node
 * process behind the PTY: it reads the coordinates the spawn cannot know (the
 * distribution and optional user come from the session, handed over through
 * `DSH_WSL_DISTRO`/`DSH_WSL_USER`), then hands its own stdio — the PTY — to
 * `wsl.exe`, so the model gets a stateful shell inside the distribution
 * instead of one process per call.
 *
 * The inner shell is started as `bash -lc '<cd …> && exec bash -i'`: the login
 * pass loads `/etc/profile` and the user profile (PATH and friends), and the
 * interactive shell that replaces it keeps the session directory. A plain
 * `bash -l` can be sent to `$HOME` by a profile — that is why the one-shot
 * executor prefixes an explicit `cd` too.
 *
 * Resolution: the UNC cwd names its distribution, else `DSH_WSL_DISTRO`, else
 * the host's default distribution; `DSH_WSL_USER` selects `wsl.exe -u`. Every
 * failure is reported on stderr and exits non-zero, so a broken shell surfaces
 * instead of leaving a silent dead terminal.
 *
 * Ported from dsh-wsl-workspace 0.7.3 `src/host/wsl-relay.ts`
 * (https://github.com/6Mikao9/dsh-wsl-workspace, MIT).
 *
 * @module @deepseek-ai/dsh-world-wsl/relay
 */

import { spawn } from 'node:child_process'
import { isValidWslUsername, parseWslUnc, windowsToMntPath } from './paths.ts'
import { defaultDistroSync } from './wsl.ts'

/** Shell signals whose arrival means this relay should take the shell down. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']

/** POSIX single-quote a path so the `cd` command reaches bash as one word. */
function quote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`
}

/** Fail loudly: the PTY has no other way to tell the model what went wrong. */
function fail(message: string): never {
  console.error(`dsh-wsl-workspace: ${message}`)
  process.exit(1)
}

/** The distribution this shell belongs to. */
function resolveDistro(uncDistro: string | undefined): string {
  if (uncDistro !== undefined && uncDistro !== '') return uncDistro
  const fromEnv = process.env.DSH_WSL_DISTRO
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const fallback = defaultDistroSync()
  if (fallback !== undefined && fallback !== '') return fallback
  return fail('persistent shell: the session cwd carries no distribution, DSH_WSL_DISTRO is unset and no WSL default is readable')
}

/** The workspace user, when one is configured and safe for `wsl.exe -u`. */
function resolveUser(): string | undefined {
  const user = process.env.DSH_WSL_USER
  if (user === undefined || user === '') return undefined
  if (!isValidWslUsername(user)) fail(`persistent shell: refusing the malformed username "${user}"`)
  return user
}

const cwd = process.cwd()
const unc = parseWslUnc(cwd)
const distro = resolveDistro(unc?.distro)
const user = resolveUser()
// The PTY's cwd is what `wsl.exe` inherits; it accepts both the UNC form of its
// own filesystem and a drive path (mapped to `/mnt/<drive>`), so it is handed
// through unchanged and only the login shell's `cd` needs the Linux spelling.
const linuxCwd = unc !== null ? unc.linuxPath : windowsToMntPath(cwd) ?? undefined
const command = `${linuxCwd === undefined ? '' : `cd ${quote(linuxCwd)} && `}exec bash -i`
const argv = [
  'wsl.exe',
  '-d', distro,
  ...user === undefined ? [] : ['-u', user],
  '--cd', cwd,
  '-e', 'bash',
  '-lc', command,
]

const child = spawn(argv[0] ?? 'wsl.exe', argv.slice(1), { stdio: 'inherit' })
child.on('error', (error: Error) => fail(`persistent shell: cannot start ${argv[0] ?? 'wsl.exe'} (${error.message})`))
child.on('exit', (code, signal) => process.exit(signal === null ? code ?? 0 : 1))
for (const signal of FORWARDED_SIGNALS) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  })
}
