/**
 * The SSH world's `FileSystem`: every operation executes ON the remote host
 * over the pooled connection (no mirror sync). Identity keys are remote
 * canonical `realpath` paths; reads/writes ride base64 frames; mutations are
 * remote temp + rename, fenced at the remote realpath by the per-call policy
 * the world router passes through.
 *
 * @module @deepseek-ai/dsh-world-ssh/fs
 */

import { posix } from 'node:path'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { MirrorRoot } from './profile.ts'
import type { SshProfile } from './profile.ts'
import { pathInside } from './profile.ts'
import type { SshSessionPool } from './session.ts'
import { shellQuote, shellQuotePath } from './ssh.ts'

/** One remote stat frame's fields: size, mtime seconds, GNU %F type text. */
interface RemoteStat {
  size: number
  mtimeMs: number
  type: 'file' | 'directory' | 'symlink' | 'other'
  error?: string
}

/** Backend config. */
export interface SshFsConfig {
  /** Root for bare relative paths without a per-call cwd (default `~`). */
  remoteRoot?: string
}

/** The host capabilities the SSH filesystem consumes. */
export interface SshFsDeps {
  /** The pooled remote command channel. */
  pool: SshSessionPool
  /** Mirror roots for translating local mirror paths to remote paths. */
  mirrorRoots: readonly MirrorRoot[]
}

/** The stat-frame marker line prefix. */
const DSH_ST_MARK = '__DSH_ST__'

/** One remote run's parsed frame: the stat record plus the remaining payload text. */
interface FramedRun {
  stat: RemoteStat | null
  rest: string
}

/** stat 帧命令：size mtime type + 标记行；stat 失败 → ERR 标记 + false。 */
function statFrameSnippet(): string {
  return `if st=$(stat -c'%s %Y %F' -- "$f" 2>&1); then printf '${DSH_ST_MARK}%s:%s:%s\\n' "\${st%% *}" "$(printf '%s' "$st" | awk '{print $2}')" "$(printf '%s' "$st" | cut -d' ' -f3-)"; `
}

function errSnippet(): string {
  return `else printf '${DSH_ST_MARK}ERR:%s\\n' "$(printf '%s' "$st" | tr '\\r\\n' '  ' | cut -c1-200)"; false; fi`
}

/** Parse one framed run's leading stat line. */
function parseFramedRun(stdout: string): FramedRun {
  const nl = stdout.indexOf('\n')
  if (nl < 0 || !stdout.startsWith(DSH_ST_MARK)) return { stat: null, rest: stdout }
  const head = stdout.slice(DSH_ST_MARK.length, nl)
  const rest = stdout.slice(nl + 1)
  if (head.startsWith('ERR:')) return { stat: { size: 0, mtimeMs: 0, type: 'other', error: head.slice(4) }, rest }
  const [sizeStr, mtimeStr, typeStr] = [head.slice(0, head.indexOf(':')), head.slice(head.indexOf(':') + 1, head.lastIndexOf(':')), head.slice(head.lastIndexOf(':') + 1)]
  const size = Number.parseInt(sizeStr, 10)
  const mtime = Number.parseFloat(mtimeStr)
  const typeText = typeStr.trim()
  return {
    stat: {
      size: Number.isFinite(size) ? size : 0,
      mtimeMs: Number.isFinite(mtime) ? Math.round(mtime * 1000) : 0,
      type: typeText === 'regular file' || typeText === 'regular empty file' ? 'file' : typeText === 'directory' ? 'directory' : typeText === 'symbolic link' ? 'symlink' : 'other',
    },
    rest,
  }
}

/** Decode one base64 payload into bytes. */
function decodeBase64(rest: string): Uint8Array {
  const compact = rest.replace(/\s+/g, '')
  return new Uint8Array(Buffer.from(compact, 'base64'))
}

/** Whether decoded text is binary (a NUL in the first 8000 bytes). */
function isBinaryText(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0)
}

/** The version token of one stat record. */
function versionOf(stat: RemoteStat): FsVersion {
  return FsVersion(`${stat.size}:${stat.mtimeMs}`)
}

/** The stream chunk size for streamText. */
const STREAM_CHUNK_BYTES = 256 * 1024

/** Apply one literal edit with the host backend's exact semantics. */
function applyLiteralEdit(content: string, oldString: string, newString: string, replaceAll: boolean, displayPath: string): string {
  if (oldString === '') throw new FsError(`cannot edit "${displayPath}": oldString must be non-empty`, 'FS_EDIT_NOT_FOUND')
  const matches = content.split(oldString).length - 1
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": oldString not found`, 'FS_EDIT_NOT_FOUND')
  if (matches > 1 && !replaceAll) {
    throw new FsError(`cannot edit "${displayPath}": oldString is ambiguous (${matches} matches; pass replaceAll to replace every one)`, 'FS_AMBIGUOUS_EDIT')
  }
  return content.split(oldString).join(newString)
}

/**
 * The SSH filesystem backend. All metadata and content flow through
 * `deps.pool` (pooled shell, one-shot fallback); nothing is mirrored locally.
 */
export class SshFileSystem extends FileSystem {
  private readonly remoteRoot: string

  constructor(
    ctx: Context,
    private readonly profile: SshProfile,
    private readonly deps: SshFsDeps,
    config?: SshFsConfig,
  ) {
    super(ctx)
    this.remoteRoot = config?.remoteRoot ?? profile.remoteRoot ?? '~'
  }

  // ---- path model -----------------------------------------------------------

  /** The local mirror root covering a host path, when any. */
  private mirrorOf(hostPath: string): MirrorRoot | undefined {
    return this.deps.mirrorRoots.find(mirror => pathInside(mirror.root, hostPath))
  }

  /**
   * Translate a model/plugin path into a remote path. Linux-absolute paths are
   * remote-native; a path under a mirror root maps to `remotePath + relative`;
   * a relative path resolves against the per-call cwd (or the remote root).
   */
  private remotePath(path: string, cwd?: string): string {
    if (path.startsWith('/')) return posix.normalize(path)
    if (path.startsWith('~')) return path
    const mirror = this.mirrorOf(path)
    if (mirror !== undefined) {
      const relative = path.slice(mirror.root.length).replace(/\\/g, '/').replace(/^\/+/, '')
      return posix.join(mirror.info.remotePath, relative)
    }
    const base = cwd !== undefined && cwd !== '' ? cwd : this.remoteRoot
    if (base.startsWith('/') || base.startsWith('~')) return posix.normalize(posix.join(base, path))
    const baseMirror = this.mirrorOf(base)
    if (baseMirror !== undefined) {
      const relative = base.slice(baseMirror.root.length).replace(/\\/g, '/').replace(/^\/+/, '')
      return posix.normalize(posix.join(baseMirror.info.remotePath, relative, path))
    }
    return posix.normalize(posix.join(this.remoteRoot, path))
  }

  // ---- remote command helpers ----------------------------------------------

  /** Run one remote shell command over the pool. */
  private async run(cmd: string, stdinData?: string, timeoutMs?: number) {
    return this.deps.pool.runPooled(this.profile, cmd, stdinData, undefined, false, timeoutMs)
  }

  /** Run a stat frame on one remote path. */
  private async statRemote(remotePath: string): Promise<RemoteStat | null> {
    const run = await this.run(`f=${shellQuotePath(remotePath)}; ${statFrameSnippet()}${errSnippet()}`)
    const framed = parseFramedRun(run.stdout)
    if (framed.stat?.error !== undefined) {
      throw new FsError(`cannot stat "${remotePath}": ${framed.stat.error}`, 'FS_IO_ERROR')
    }
    return framed.stat
  }

  /** Canonical remote identity of one path (1 RTT; GNU realpath -m works for missing files). */
  private async realpathRemote(remotePath: string): Promise<string> {
    const run = await this.run(`realpath -m -- ${shellQuotePath(remotePath)}`)
    if (!run.ok || run.stdout.trim() === '') {
      throw new FsError(`cannot resolve "${remotePath}": ${run.error || run.stderr.trim() || 'realpath failed'}`, 'FS_IO_ERROR')
    }
    return run.stdout.trim()
  }

  /** Read one byte window as base64: offset 0-based, length the byte cap. */
  private async readBytesRemote(remotePath: string, offset: number, length: number): Promise<Uint8Array> {
    const cmd = length === 0
      ? 'true'
      : offset === 0
        ? `head -c ${length} -- ${shellQuotePath(remotePath)} | base64 -w0`
        : `tail -c +${offset + 1} -- ${shellQuotePath(remotePath)} | head -c ${length} | base64 -w0`
    const run = await this.run(cmd)
    if (!run.ok) {
      throw new FsError(`cannot read "${remotePath}": ${run.error || run.stderr.trim() || 'read failed'}`, 'FS_IO_ERROR')
    }
    return decodeBase64(run.stdout)
  }

  /** Stat then require a regular file. */
  private async requireRegularFile(remotePath: string, display: string): Promise<RemoteStat> {
    const stat = await this.statRemote(remotePath)
    if (stat === null) throw new FsError(`cannot read "${display}": stat frame missing`, 'FS_IO_ERROR')
    if (stat.type !== 'file') {
      throw new FsError(`cannot read "${display}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    return stat
  }

  /** Decode and require text. */
  private decodeText(bytes: Uint8Array, display: string): string {
    if (isBinaryText(bytes)) {
      throw new FsError(`cannot read "${display}": file is not UTF-8 text (binary content)`, 'FS_NOT_TEXT')
    }
    return new TextDecoder().decode(bytes)
  }

  // ---- FileSystem contract ----------------------------------------------------

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    const remote = this.remotePath(path, opts?.cwd)
    const canonical = await this.realpathRemote(remote)
    return { targetKey: FsTargetKey(canonical), displayPath: canonical }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    const mirror = this.mirrorOf(hostPath)
    if (mirror === undefined) return undefined
    const relative = hostPath.slice(mirror.root.length).replace(/\\/g, '/').replace(/^\/+/, '')
    return posix.join(mirror.info.remotePath, relative)
  }

  override fileUrl(target: FsTarget): string {
    const remote = String(target.targetKey)
    const encoded = remote.split('/').map(encodeURIComponent).join('/')
    return `file://${encoded}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentPath = String(parent.targetKey)
    const childPath = String(child.targetKey)
    if (childPath === parentPath) return true
    return parentPath === '/' ? true : childPath.startsWith(`${parentPath}/`)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    try {
      const stat = await this.statRemote(String(target.targetKey))
      if (stat === null) return undefined
      return { version: versionOf(stat), type: stat.type === 'symlink' ? 'other' : stat.type, size: stat.size }
    } catch (error) {
      if (error instanceof FsError && /no such file/i.test(error.message)) return undefined
      throw error
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    signal?.throwIfAborted()
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const remote = this.remotePath(path, opts?.cwd)
    const run = await this.run(
      `f=${shellQuotePath(remote)}; if [ -L "$f" ]; then printf '${DSH_ST_MARK}0:0:symlink\\n'; elif [ -e "$f" ]; then ${statFrameSnippet()}${errSnippet()}; fi`,
    )
    if (!run.ok && run.stdout.trim() === '') {
      throw new FsError(`cannot lstat "${remote}": ${run.error || run.stderr.trim() || 'lstat failed'}`, 'FS_IO_ERROR')
    }
    if (run.stdout.trim() === '') return undefined
    const framed = parseFramedRun(run.stdout)
    if (framed.stat?.error !== undefined) return undefined
    if (framed.stat === null) return undefined
    return { version: versionOf(framed.stat), type: framed.stat.type, size: framed.stat.size }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const remote = String(target.targetKey)
    await this.requireRegularFile(remote, target.displayPath)
    const bytes = await this.readBytesRemote(remote, 0, Number.MAX_SAFE_INTEGER)
    return this.decodeText(bytes, target.displayPath)
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return Promise.resolve(this.streamTextChunks(target, signal))
  }

  /** The chunk generator behind {@link streamText}. */
  private async *streamTextChunks(target: FsTarget, signal?: AbortSignal): AsyncIterable<string> {
    const remote = String(target.targetKey)
    const stat = await this.requireRegularFile(remote, target.displayPath)
    let offset = 0
    const decoder = new TextDecoder()
    while (offset < stat.size) {
      signal?.throwIfAborted()
      const chunk = await this.readBytesRemote(remote, offset, Math.min(STREAM_CHUNK_BYTES, stat.size - offset))
      if (chunk.length === 0) break
      if (isBinaryText(chunk)) {
        throw new FsError(`cannot stream "${target.displayPath}": file is not UTF-8 text (binary content)`, 'FS_NOT_TEXT')
      }
      offset += chunk.length
      yield decoder.decode(chunk, { stream: offset < stat.size })
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    signal?.throwIfAborted()
    const stat = await this.requireRegularFile(String(target.targetKey), target.displayPath)
    if (stat.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": file too large (${stat.size} bytes > ${maxBytes} byte cap)`, 'FS_TOO_LARGE')
    }
    return this.readBytesRemote(String(target.targetKey), 0, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()
    const remote = String(target.targetKey)
    const stat = await this.requireRegularFile(remote, target.displayPath)
    if (range.offset >= stat.size) return new Uint8Array(0)
    return this.readBytesRemote(remote, range.offset, Math.min(range.length, stat.size - range.offset))
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted()
    const remote = String(target.targetKey)
    const stat = await this.statRemote(remote)
    if (stat === null) throw new FsError(`cannot list "${target.displayPath}": stat frame missing`, 'FS_IO_ERROR')
    if (stat.type !== 'directory') {
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    }
    const run = await this.run(`find ${shellQuotePath(remote)} -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n' 2>/dev/null`)
    if (!run.ok) {
      throw new FsError(`cannot list "${target.displayPath}": ${run.error || run.stderr.trim() || 'find failed'}`, 'FS_IO_ERROR')
    }
    const entries: FsDirEntry[] = []
    for (const line of run.stdout.split('\n')) {
      if (line === '') continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const typeChar = line.slice(0, tab)
      const name = line.slice(tab + 1)
      if (name === '') continue
      entries.push({
        name,
        type: typeChar === 'f' ? 'file' : typeChar === 'd' ? 'directory' : 'other',
        target: { targetKey: FsTargetKey(posix.join(remote, name)), displayPath: posix.join(remote, name) },
      })
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    return entries
  }

  // ---- mutations: fence + temp+rename ----------------------------------------

  /**
   * The remote fence: the per-call policy (passed by the world router verbatim)
   * or the standing deployment policy; a claimed SSH workspace always allows
   * `danger-full-access`-free paths only under the remote workspace root or the
   * remote `/tmp`.
   */
  private sandboxPolicyOf(perCall?: SandboxExecutionPolicy): SandboxExecutionPolicy | undefined {
    if (perCall !== undefined) return perCall
    const service = this.ctx.get('sandboxPolicy')
    if (service === undefined) return undefined
    try {
      return service.resolve()
    } catch {
      return undefined
    }
  }

  /** The deployment's default sandbox mode — the capability fact tools advertise escalation from. */
  override get sandboxMode(): SandboxMode | undefined {
    return this.ctx.get('sandboxPolicy')?.defaultMode
  }

  /** The remote roots a write may land under. */
  private writableRemoteRoots(policy: SandboxExecutionPolicy): string[] {
    const roots: string[] = []
    const workspace = policy.workspaceRoot
    const mirror = this.mirrorOf(workspace)
    if (mirror !== undefined) roots.push(mirror.info.remotePath)
    else if (workspace.startsWith('/')) roots.push(workspace)
    for (const extra of policy.extraWritableRoots ?? []) {
      const extraMirror = this.mirrorOf(extra)
      if (extraMirror !== undefined) roots.push(extraMirror.info.remotePath)
      else if (extra.startsWith('/')) roots.push(extra)
    }
    roots.push('/tmp')
    return roots
  }

  /** Whether a canonical remote path is a writable root or sits below one. */
  private underRoot(target: string, root: string): boolean {
    const key = posix.normalize(target)
    const base = posix.normalize(root)
    if (base === '/' || key === base) return true
    return key.startsWith(`${base}/`)
  }

  /**
   * Fence a mutation by the policy at the remote realpath, then return the
   * EXACT remote path to mutate (the world-wsl checkedTarget pattern).
   */
  private async checkedTarget(
    target: FsTarget,
    perCall?: SandboxExecutionPolicy,
  ): Promise<{ remote: string; policy: SandboxExecutionPolicy | undefined }> {
    const policy = this.sandboxPolicyOf(perCall)
    const remote = String(target.targetKey)
    if (policy === undefined || policy.mode === 'danger-full-access') return { remote, policy }
    if (policy.mode === 'read-only') {
      throw new FsError(
        `cannot write "${target.displayPath}": file access denied under read-only mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    const fresh = await this.realpathRemote(remote)
    for (const root of this.writableRemoteRoots(policy)) {
      if (this.underRoot(fresh, root)) return { remote: fresh, policy }
    }
    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
      'FS_SANDBOX_DENIED',
    )
  }

  /** Atomically publish staged content to a remote path (temp + rename). */
  private async writeRemote(remote: string, content: string, expected: FsWriteIntent | undefined, signal?: AbortSignal): Promise<void> {
    const publish = 'base64 -d > "$tmp" && mv -f -- "$tmp" "$f" || rc=$?'
    // Refusals set rc instead of exiting, so the trailing cleanup always runs
    // and a refused or failed write never leaves the mktemp staging file.
    const body = expected === undefined
      ? publish
      : expected.kind === 'createIfAbsent'
        ? `if [ -e "$f" ]; then printf 'exists\\n' >&2; rc=17; else ${publish}; fi`
        : `st=$(stat -c'%s %Y' -- "$f" 2>/dev/null) || st='0 0'; if [ "$(printf '%s' "$st" | awk '{print $1":"$2}' | awk -F: '{printf "%s:%s", $1, int($2*1000)}')" != ${shellQuote(String(expected.version))} ]; then printf 'stale\\n' >&2; rc=23; else ${publish}; fi`
    const base64 = Buffer.from(content, 'utf8').toString('base64')
    // The heredoc payload rides the LAST command's stdin, so the whole write
    // runs in one subshell: base64 reads the payload, mv inherits its EOF.
    const cmd = `f=${shellQuotePath(remote)}; d=$(dirname -- "$f"); tmp=$(mktemp "$d/.dsh-write-XXXXXXXX") && (rc=0; ${body}; if [ $rc -ne 0 ]; then rm -f -- "$tmp"; exit $rc; fi)`
    const run = await this.run(cmd, base64, 60_000)
    signal?.throwIfAborted()
    if (run.exitCode === 17) {
      throw new FsError(`cannot write "${remote}": file already exists`, 'FS_PERMISSION_DENIED')
    }
    if (run.exitCode === 23) {
      throw new FsError(`cannot write "${remote}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    if (!run.ok) {
      throw new FsError(`cannot write "${remote}": ${run.error || run.stderr.trim() || 'write failed'}`, 'FS_IO_ERROR')
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const { remote } = await this.checkedTarget(target, sandboxPolicy)
    let before: string | null = null
    let operation: 'create' | 'update' = 'create'
    try {
      before = await this.readText({ targetKey: target.targetKey, displayPath: target.displayPath }, signal)
      operation = 'update'
    } catch (error) {
      // Absent, unreadable, or non-text prior content: the write is a create
      // and the outcome simply carries no diff basis.
      if (!(error instanceof FsError)) throw error
      before = null
    }
    await this.writeRemote(remote, content, expected, signal)
    const stat = await this.statRemote(remote)
    return {
      operation,
      version: stat === null ? FsVersion(`missing:${remote}`) : versionOf(stat),
      before,
      after: content,
    }
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const { remote } = await this.checkedTarget(target, sandboxPolicy)
    const stat = await this.requireRegularFile(remote, target.displayPath)
    if (expected !== undefined && versionOf(stat) !== expected.version) {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const original = await this.readText(target, signal)
    const edited = applyLiteralEdit(original, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
    await this.writeRemote(remote, edited, expected === undefined ? undefined : { kind: 'replaceIfVersion', version: expected.version }, signal)
    const after = await this.statRemote(remote)
    return {
      version: after === null ? FsVersion(`missing:${remote}`) : versionOf(after),
      before: original,
      after: edited,
    }
  }

  override watch(): Promise<() => Promise<void>> {
    return Promise.reject(new FsError('Filesystem watching is not supported by the SSH world (no inotify channel over 9P-free links).', 'FS_IO_ERROR'))
  }
}
