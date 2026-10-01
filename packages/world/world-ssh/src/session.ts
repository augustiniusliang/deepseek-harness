/**
 * The pooled persistent bash session per SSH profile: one long-lived
 * `ssh … bash` process per profile, commands written to its stdin behind a
 * random sentinel protocol, and a serial queue so the shared shell's state
 * (cwd, variables) stays coherent per profile.
 *
 * 工作原理：向 bash 的 stdin 写入命令 + 哨兵标记 printf，从 stdout 读取直到哨兵出现，
 * 哨兵后的数字即退出码。split（分离 stderr）模式下，stderr 重定向到远端临时文件，
 * 退出码哨兵之后 cat 出来并用第二个哨兵收尾。输出侧有硬上限 SESSION_MAX_STDOUT：
 * 哨兵出现前缓冲超限即重置会话，下次调用自动重建。
 *
 * Ported from dsh-remote-ssh 2.4.15 `lib/index.js` (`CommandSession`)
 * (https://github.com/ZhangFengshun/dsh-remote-ssh, MIT).
 *
 * @module @deepseek-ai/dsh-world-ssh/session
 */

import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SshProfile } from './profile.ts'
import { profileKey } from './profile.ts'
import { sshArgv, sshErrorHint, stripPqBanner, withTimeout, resolveTimeoutMs, MAX_BYTES } from './ssh.ts'

/** Type guard for the timeout marker `withTimeout` attaches. */
function isTimeoutError(error: unknown): error is Error & { isTimeout: true } {
  return error instanceof Error && 'isTimeout' in error && error.isTimeout === true
}

/** 单条命令输出的硬上限：哨兵出现前缓冲超过即重置会话。 */
const SESSION_MAX_STDOUT = MAX_BYTES
/** 池化会话的空闲回收周期。 */
export const SESSION_IDLE_MS = 10 * 60 * 1000

/** One queued command's settlement shape. */
interface SessionResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface QueueItem {
  cmd: string
  stdinData: string | undefined
  split: boolean
  resolve: (result: SessionResult) => void
  reject: (error: Error) => void
  exitParsed: boolean
  exitCode: number
  stdout: string
  stderr: string
  errSentinel: string | null
}

/**
 * One profile's persistent bash session. `exec` serializes commands over the
 * queue; a dying session rejects the in-flight and every queued command, and
 * the next `exec` reconnects.
 */
export class CommandSession {
  private handle: SubprocessHandle | null = null
  private alive = false
  private buf = ''
  private errBuf = ''
  private queue: QueueItem[] = []
  private current: QueueItem | null = null
  private readonly sentinel = `DSHEOF${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 10)}DSHEOF`
  private connectPromise: Promise<void> | null = null
  /** 空闲回收读取的最近使用时间。 */
  lastUsed = Date.now()

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly profile: SshProfile,
  ) {}

  /** Ensure the persistent `ssh … bash` process is up; concurrent callers share one connect. */
  async connect(): Promise<void> {
    if (this.alive && this.handle !== null) return
    this.connectPromise ??= this.doConnect()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  // oxlint-disable-next-line typescript/require-await -- async keeps a spawn rejection a rejection, not a sync throw
  private async doConnect(): Promise<void> {
    if (this.handle !== null) {
      try {
        this.handle.terminate()
      } catch {
        // Terminating a dying handle is best-effort.
      }
      this.handle = null
    }
    this.alive = false
    this.buf = ''
    this.errBuf = ''
    this.current = null
    this.queue = []
    const h = this.subprocess.spawn({
      argv: sshArgv(this.profile, 'bash', false),
      cwd: process.cwd(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 60_000,
    })
    this.handle = h
    h.stdout?.on('data', (chunk: Buffer | string) => {
      this.buf += chunk.toString()
      this.check()
    })
    // stderr 必须消费：不挂监听会让管道缓冲填满、远端 ssh 写 stderr 阻塞（会话假死）。
    // 保留最近 64KB 用于会话关闭时的诊断。
    h.stderr?.on('data', (chunk: Buffer | string) => {
      this.errBuf = (this.errBuf + chunk.toString()).slice(-65536)
    })
    const onEnd = (): void => {
      this.alive = false
      const errMsg = `ssh 会话已关闭${this.errBuf.trim() ? `: ${stripPqBanner(this.errBuf).trim().slice(-300)}` : ''}`
      if (this.current !== null) {
        this.current.reject(new Error(errMsg))
        this.current = null
      }
      while (this.queue.length > 0) this.queue.shift()?.reject(new Error(errMsg))
    }
    h.stdout?.on('end', onEnd)
    h.stdout?.on('error', onEnd)
    h.done.then(() => { this.alive = false }, () => { this.alive = false })
    this.alive = true
    this.lastUsed = Date.now()
  }

  private check(): void {
    if (this.current === null) return
    const item = this.current
    if (!item.exitParsed) {
      // 找到主哨兵：解析退出码；split 模式还要等第二个哨兵（stderr 内容）
      const idx = this.buf.indexOf(this.sentinel)
      if (idx < 0) {
        this.enforceCap()
        return
      }
      const before = this.buf.slice(0, idx)
      const after = this.buf.slice(idx + this.sentinel.length)
      const nl = after.indexOf('\n')
      const codeStr = nl >= 0 ? after.slice(0, nl) : after
      this.buf = nl >= 0 ? after.slice(nl + 1) : ''
      const exitCode = Number.parseInt(codeStr, 10)
      item.exitCode = Number.isNaN(exitCode) ? -1 : exitCode
      item.stdout = before
      item.exitParsed = true
      if (item.errSentinel === null) {
        this.current = null
        item.resolve({ stdout: item.stdout, stderr: item.stderr, exitCode: item.exitCode })
        this.next()
        return
      }
    }
    if (item.errSentinel !== null) {
      // split 模式第二段：等 stderr 哨兵（可能已在缓冲里）
      const idx = this.buf.indexOf(item.errSentinel)
      if (idx < 0) {
        this.enforceCap()
        return
      }
      const errText = this.buf.slice(0, idx)
      const after = this.buf.slice(idx + item.errSentinel.length)
      const nl = after.indexOf('\n')
      this.buf = nl >= 0 ? after.slice(nl + 1) : ''
      item.stderr = errText.replace(/\n$/, '')
      this.current = null
      item.resolve({ stdout: item.stdout, stderr: item.stderr, exitCode: item.exitCode })
      this.next()
    }
  }

  /** 单条命令输出超过硬上限：立即重置会话（下次调用自动重建），拒绝挂起/撑爆内存。 */
  private enforceCap(): void {
    if (this.current === null || this.buf.length < SESSION_MAX_STDOUT) return
    const item = this.current
    this.current = null
    item.reject(new Error(`单条命令输出超过 ${SESSION_MAX_STDOUT} 字节上限，会话已重置（若确实需要更大输出请拆分命令）`))
    this.alive = false
    if (this.handle !== null) {
      try {
        this.handle.terminate()
      } catch {
        // Terminating a dying handle is best-effort.
      }
      this.handle = null
    }
    while (this.queue.length > 0) this.queue.shift()?.reject(new Error('ssh 会话已重置'))
  }

  private next(): void {
    if (this.current !== null || !this.alive || this.queue.length === 0) return
    const item = this.queue.shift() as QueueItem
    item.exitParsed = false
    item.stdout = ''
    item.stderr = ''
    item.exitCode = -1
    item.errSentinel = item.split
      ? `DSHERR${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 8)}`
      : null
    this.current = item
    try {
      const errFile = `\${TMPDIR:-/tmp}/.dsh-err-${Math.random().toString(36).slice(2, 10)}`
      const exitMark = `printf '\\n${this.sentinel}%s\\n' $?`
      const errTail = `cat ${errFile} 2>/dev/null; rm -f ${errFile}; printf '\\n${item.errSentinel ?? ''}ok\\n'`
      let toWrite: string
      if (item.split) {
        // 分离 stderr 用双层子 shell：外层 ( ... ) 保证 printf 链自身不受用户命令返回值影响；
        // 内层 ( { cmd ; } ) 隔离用户命令里的 exit/cd，绝不弄挂共享 bash 会话。
        if (item.stdinData !== undefined) {
          const delim = `DSHW${Math.random().toString(36).slice(2, 14)}`
          toWrite = `( ( ${item.cmd} <<'${delim}'\n${item.stdinData}\n${delim}\n) 2>${errFile}; ${exitMark}; ${errTail} )\n`
        } else {
          toWrite = `( ( ${item.cmd} ; ) 2>${errFile}; ${exitMark}; ${errTail} )\n`
        }
      } else if (item.stdinData !== undefined) {
        // 快速路径写操作：heredoc 传内容，2>&1 合并（成功时 stderr 为空，不影响解析）
        const delim = `DSHW${Math.random().toString(36).slice(2, 14)}`
        toWrite = `${item.cmd} <<'${delim}'\n${item.stdinData}\n${delim}\n${exitMark}\n`
      } else {
        // 读/列举/搜索快速路径：2>&1 合并 stderr（成功时 stderr 为空）
        toWrite = `{ ${item.cmd} ; } 2>&1\n${exitMark}\n`
      }
      this.handle?.stdin?.write(toWrite)
    } catch (error) {
      this.current = null
      item.reject(error instanceof Error ? error : new Error(String(error)))
      this.next()
    }
  }

  /**
   * Run one command over the pooled session.
   * @param cmd - the remote shell command line.
   * @param stdinData - optional heredoc payload (write frames).
   * @param split - separate stderr behind the second sentinel.
   * @returns the command's output and exit code.
   */
  async exec(cmd: string, stdinData?: string, split?: boolean): Promise<SessionResult> {
    await this.connect()
    this.lastUsed = Date.now()
    return new Promise<SessionResult>((resolve, reject) => {
      this.queue.push({ cmd, stdinData, split: split === true, resolve, reject, exitParsed: false, exitCode: -1, stdout: '', stderr: '', errSentinel: null })
      this.next()
    })
  }

  /** Terminate the session and reject everything pending. */
  close(): void {
    this.alive = false
    if (this.current !== null) {
      this.current.reject(new Error('session closed'))
      this.current = null
    }
    while (this.queue.length > 0) this.queue.shift()?.reject(new Error('session closed'))
    if (this.handle !== null) {
      try {
        this.handle.terminate()
      } catch {
        // Terminating a dying handle is best-effort.
      }
      this.handle = null
    }
  }
}

/** One remote command's normalized outcome across the pooled and one-shot paths. */
export interface RemoteRun {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  error: string
  truncated: boolean
  isTimeout?: boolean
}

/**
 * The session pool: one `CommandSession` per profile, idle reaping, and the
 * `runPooled` discipline — pooled first, exit 255 (连接层失败) drops the
 * session, command timeout drops it too (挂起的远端命令仍占着共享 bash，唯一
 * 可靠恢复是终止重建), and a session failure falls back to a one-shot
 * connection once.
 */
export class SshSessionPool {
  private readonly sessions = new Map<string, CommandSession>()
  private readonly idleTimer: ReturnType<typeof setInterval>

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly idleMs: number = SESSION_IDLE_MS,
  ) {
    this.idleTimer = setInterval(() => {
      this.reapIdle()
    }, 60_000)
    this.idleTimer.unref()
  }

  /** Dispose every session and stop the reaper. */
  dispose(): void {
    clearInterval(this.idleTimer)
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }

  /** Current live session count (tests and diagnostics). */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Reap sessions idle past the limit.
   * @param now - the timestamp to compare against (defaults to the current time).
   */
  reapIdle(now: number = Date.now()): void {
    for (const [key, session] of this.sessions) {
      if (now - session.lastUsed > this.idleMs) {
        session.close()
        this.sessions.delete(key)
      }
    }
  }

  private getSession(p: SshProfile): CommandSession {
    const key = profileKey(p)
    let session = this.sessions.get(key)
    if (session === undefined) {
      session = new CommandSession(this.subprocess, p)
      this.sessions.set(key, session)
    }
    return session
  }

  private dropSession(p: SshProfile): void {
    const key = profileKey(p)
    const old = this.sessions.get(key)
    if (old !== undefined) {
      old.close()
      this.sessions.delete(key)
    }
  }

  /**
   * Run one command through the pool (or the one-shot fallback), with the
   * upstream `runPooled` semantics.
   * @param p - the connection profile.
   * @param cmd - the remote shell command line.
   * @param stdinData - optional heredoc payload.
   * @param maxBytes - per-stream output budget (one-shot path).
   * @param split - separate stderr (double sentinel).
   * @param timeoutMs - command timeout; a timed-out command drops the session.
   * @returns the normalized run outcome.
   */
  async runPooled(
    p: SshProfile,
    cmd: string,
    stdinData?: string,
    maxBytes?: number,
    split?: boolean,
    timeoutMs?: number,
  ): Promise<RemoteRun> {
    const tms = resolveTimeoutMs(timeoutMs)
    try {
      const session = this.getSession(p)
      const result = await withTimeout(session.exec(cmd, stdinData, split), tms, '池化命令', () => {
        this.dropSession(p)
      })
      const stderr = split === true ? result.stderr : ''
      if (result.exitCode === 0) {
        return { ok: true, exitCode: 0, stdout: result.stdout, stderr, error: '', truncated: false }
      }
      // exit 255 = ssh 连接层失败（非远程命令失败）：会话作废，下次调用重建。
      if (result.exitCode === 255) this.dropSession(p)
      const errSource = stderr || result.stdout
      const error = result.exitCode === 255
        ? sshErrorHint(errSource)
        : (errSource.trim().slice(0, 500) || `ssh 退出码 ${result.exitCode}`)
      return { ok: false, exitCode: result.exitCode, stdout: result.stdout, stderr, error, truncated: false }
    } catch (error) {
      this.dropSession(p)
      // 超时不走一次性连接回退：重试一条挂起的命令只会再次挂起。
      if (isTimeoutError(error)) {
        return { ok: false, exitCode: -1, stdout: '', stderr: '', truncated: false, isTimeout: true, error: error.message }
      }
      // 会话挂了 —— 清理并回退到一次性连接（相当于自动重连一次）
      const fallback = await this.runRemote(p, cmd, stdinData, maxBytes, tms)
      if (!fallback.ok && fallback.exitCode === 255) fallback.error = sshErrorHint(fallback.stdout || fallback.stderr || fallback.error)
      return fallback
    }
  }

  /**
   * One-shot execution over a fresh connection: spawn, await with the command
   * timeout (挂起的命令在超时后被 terminate，不重试), read bounded streams.
   * @param p - the connection profile.
   * @param cmd - the remote shell command line.
   * @param stdinData - optional stdin payload.
   * @param maxBytes - per-stream output budget.
   * @param timeoutMs - command timeout.
   * @returns the normalized run outcome.
   */
  async runRemote(
    p: SshProfile,
    cmd: string,
    stdinData?: string,
    maxBytes?: number,
    timeoutMs?: number,
  ): Promise<RemoteRun> {
    const max = maxBytes ?? MAX_BYTES
    const tms = resolveTimeoutMs(timeoutMs)
    let handle: SubprocessHandle
    try {
      handle = this.subprocess.spawn({
        argv: sshArgv(p, cmd, false),
        cwd: process.cwd(),
        stdio: {
          stdin: stdinData !== undefined ? { data: stdinData } : 'ignore',
          stdout: { maxBytes: max, spill: { maxBytes: max } },
          stderr: { maxBytes: max, spill: { maxBytes: max } },
        },
        graceMs: 3_000,
      })
    } catch (error) {
      return { ok: false, exitCode: -1, stdout: '', stderr: '', error: `spawn 失败: ${error instanceof Error ? error.message : String(error)}`, truncated: false }
    }
    let outcome
    try {
      outcome = await withTimeout(handle.done, tms, 'ssh 命令', () => {
        try {
          handle.terminate()
        } catch {
          // Terminating a dying handle is best-effort.
        }
      })
    } catch (error) {
      if (isTimeoutError(error)) {
        return { ok: false, exitCode: -1, stdout: '', stderr: '', truncated: false, isTimeout: true, error: error.message }
      }
      return { ok: false, exitCode: -1, stdout: '', stderr: '', error: `执行失败: ${error instanceof Error ? error.message : String(error)}`, truncated: false }
    }
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    const outText = stdout?.text ?? ''
    const errText = stripPqBanner(stderr?.text ?? '')
    const exitCode = outcome.exitCode ?? -1
    return {
      ok: outcome.exitCode === 0,
      exitCode,
      stdout: outText,
      stderr: errText,
      error: outcome.exitCode !== 0 && !outText && !errText
        ? `ssh 退出码 ${outcome.exitCode}${outcome.signal !== null ? ` (signal ${outcome.signal})` : ''}`
        : '',
      truncated: (stdout?.lossy ?? false) || (stderr?.lossy ?? false),
    }
  }
}
