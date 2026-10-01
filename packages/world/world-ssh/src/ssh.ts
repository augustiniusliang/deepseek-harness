/**
 * SSH connection primitives: executable resolution, argv discipline, timeouts,
 * shell quoting, and stderr hygiene shared by the pool, the one-shot fallback,
 * and the filesystem frames.
 *
 * Ported from dsh-remote-ssh 2.4.15 `lib/index.js`
 * (https://github.com/ZhangFengshun/dsh-remote-ssh, MIT).
 *
 * @module @deepseek-ai/dsh-world-ssh/ssh
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshProfile } from './profile.ts'

/** Default per-stream output budget for one remote command. */
export const MAX_BYTES = 8 * 1024 * 1024
/** Default command timeout when the caller does not state one. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/** Windows 下优先解析系统自带 OpenSSH 的绝对路径：从 git-bash 启动 dsh 时，子进程
 *  PATH 会把 Git 自带的 MSYS2 ssh 排在系统 OpenSSH 之前（HOME/config/agent 语义不同，
 *  导致密钥认证失败）。System32\OpenSSH 是 Win10 1809+ 的标准安装位置，不存在则回落 PATH。 */
let cachedSshPath: string | undefined
/**
 * Resolve the OpenSSH client executable once per process.
 * @returns the absolute System32 path on Windows when present, else the PATH name.
 */
export function sshExecutablePath(): string {
  if (cachedSshPath !== undefined) return cachedSshPath
  if (process.platform === 'win32') {
    const sysSsh = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
    if (existsSync(sysSsh)) {
      cachedSshPath = sysSsh
      return cachedSshPath
    }
  }
  cachedSshPath = 'ssh'
  return cachedSshPath
}

/**
 * Expand a leading `~` in a LOCAL path (key paths are host-side).
 * @param raw - the configured path, possibly `~`-prefixed.
 * @returns the absolute expanded path.
 */
export function expandSshPath(raw: string): string {
  const s = (raw || '').trim()
  if (s === '~') return join(homedir())
  if (s.startsWith('~/')) return join(homedir(), s.slice(2))
  return s
}

/**
 * POSIX single-quote a value so it reaches the remote shell as one word.
 * @param s - the raw argv element.
 * @returns the quoted shell word.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * 引用远程路径：开头 `~`/`~/` 保留给远程 shell 展开为家目录，其余单引号防注入。
 * @param s - the remote path.
 * @returns the quoted remote path.
 */
export function shellQuotePath(s: string): string {
  const str = s
  if (str === '~') return '~'
  if (str.startsWith('~/')) return `~/${shellQuote(str.slice(2))}`
  return shellQuote(str)
}

/**
 * The complete OpenSSH argv for one profile. Connection hygiene:
 * StrictHostKeyChecking=accept-new, ConnectTimeout=15, ServerAlive keepalive,
 * ClearAllForwardings (插件内部连接不需要端口转发；ssh config 里的转发会在
 * 端口被占时让连接直接失败), ProxyJump, key identity, BatchMode for
 * non-interactive key auth (有口令的密钥立即报错而不是挂到超时), and sshpass
 * only for password profiles.
 * @param p - the connection profile.
 * @param remoteCmd - the remote command string, or undefined for a shell/PTY.
 * @param tty - allocate a terminal (`-tt`, interactive auth allowed).
 * @param extraOpts - additional `-o`/flag arguments.
 * @returns the argv, sshpass-prefixed for password auth.
 */
export function sshArgv(p: SshProfile, remoteCmd: string | undefined, tty: boolean, extraOpts?: readonly string[]): string[] {
  const opts = [sshExecutablePath()]
  if (tty) opts.push('-tt')
  opts.push('-p', String(p.port || 22))
  opts.push('-o', 'StrictHostKeyChecking=accept-new')
  opts.push('-o', 'ConnectTimeout=15')
  opts.push('-o', 'ServerAliveInterval=30')
  opts.push('-o', 'ServerAliveCountMax=3')
  opts.push('-o', 'ClearAllForwardings=yes')
  if (p.proxyJump !== undefined && p.proxyJump !== '') opts.push('-o', `ProxyJump=${p.proxyJump}`)
  if (p.authMethod === 'key' && p.keyPath !== undefined && p.keyPath !== '') opts.push('-i', expandSshPath(p.keyPath))
  if (!tty && p.authMethod === 'key') {
    opts.push('-o', 'BatchMode=yes')
    opts.push('-o', 'PreferredAuthentications=publickey')
  }
  if (extraOpts !== undefined && extraOpts.length > 0) opts.push(...extraOpts)
  const target = `${p.user}@${p.host}`
  const head = (p.authMethod === 'password' && p.password !== undefined && p.password !== '')
    ? ['sshpass', '-p', p.password]
    : []
  const argv = head.concat(opts, [target])
  if (remoteCmd !== undefined) argv.push(remoteCmd)
  return argv
}

/**
 * 过滤 OpenSSH 客户端的“后量子 KEX”警告横幅（stderr 噪音，与认证成败无关）。
 * @param text - raw ssh stderr text.
 * @returns the text without post-quantum banner lines.
 */
export function stripPqBanner(text: string): string {
  const banner = new RegExp(
    '^\\s*\\*\\*\\s*(WARNING: connection is not using a post-quantum'
    + '|This session may be vulnerable to .?store now|The server may need to be upgraded)',
    'i',
  )
  return (text || '')
    .split('\n')
    .filter(line => !banner.test(line))
    .join('\n')
}

/**
 * One command's resolved timeout: the caller's value or the default.
 * @param timeoutMs - caller-supplied timeout; non-positive falls back to the default.
 * @returns the timeout in milliseconds.
 */
export function resolveTimeoutMs(timeoutMs?: number): number {
  return timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : DEFAULT_COMMAND_TIMEOUT_MS
}

/**
 * Race a promise against a timeout that runs a cleanup action.
 * @param promise - the work to bound.
 * @param ms - the timeout in milliseconds.
 * @param label - diagnostic label for the timeout error.
 * @param onTimeout - cleanup run before the timeout rejects.
 * @returns the promise's settlement, or a timeout rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timed = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label}超时（${ms}ms）`) as Error & { isTimeout: boolean }
      err.isTimeout = true
      if (onTimeout !== undefined) {
        try {
          onTimeout()
        } catch {
          // Cleanup best-effort: the timeout itself is what matters.
        }
      }
      reject(err)
    }, ms)
  })
  return Promise.race([promise, timed]).finally(() => { clearTimeout(timer) })
}

/**
 * 把 SSH 常见失败翻译成带修复建议的提示。
 * @param text - raw ssh stderr/stdout text.
 * @returns a localized hint with the original message appended.
 */
export function sshErrorHint(text: string): string {
  const t = stripPqBanner(text || '')
  const forward = /remote port forwarding failed for listen port (\d+)/i.exec(t)
  if (forward !== null) {
    return `SSH 端口转发失败（本地端口 ${forward[1]} 已被占用）。本插件已对该连接加 ClearAllForwardings，若仍出现请检查 ssh config。原始信息: ${t.trim().slice(0, 300)}`
  }
  if (/permission denied \(publickey/i.test(t)) {
    return `公钥认证失败（服务器拒绝了公钥）。请检查：① keyPath 指向的私钥是否正确、是否带口令（BatchMode 无法交互输口令，可先 ssh-add 加载或改用无口令密钥）；② 远端是否收录对应公钥。原始信息: ${t.trim().slice(0, 300)}`
  }
  if (/connection refused/i.test(t)) return `连接被拒绝：请确认远端 sshd 已启动且端口正确。原始信息: ${t.trim().slice(0, 300)}`
  if (/connection timed out|timed out/i.test(t)) return `连接超时：请确认网络可达、端口开放，或检查 ProxyJump 配置。原始信息: ${t.trim().slice(0, 300)}`
  if (/could not resolve hostname/i.test(t)) return `无法解析主机名：请检查连接配置中的 host 拼写。原始信息: ${t.trim().slice(0, 300)}`
  return t.trim().slice(0, 500)
}
