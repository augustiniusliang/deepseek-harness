/**
 * The WSL world's `grep` / `glob` tools: the model-facing contract of the host
 * search suite (`dsh-tool-fs-search` — same names, parameters, inline caps,
 * rendering, presenters, and search cards) executed INSIDE the calling
 * session's distribution (`wsl.exe … bash -c <fixed script>`, every
 * model-controlled value a separate positional argv element, never
 * interpolated), so searches run on the Linux kernel over the real tree
 * instead of crawling the `\\wsl.localhost` 9P share.
 *
 * Engine notes (inherited from the upstream port):
 *  - `grep` asks the distribution's GNU grep (`grep -rnIE -Z`): POSIX ERE
 *    (`\d`, `\w`, `\b`, `(?i)` work; lookaround and backreferences do not), no
 *    `.gitignore` support — hidden entries and `node_modules` are excluded
 *    explicitly while git-ignored files are still searched.
 *  - `glob` asks `find` (`-printf` reports mtimes without a stat per file);
 *    the pattern is matched in this process with ripgrep's globset semantics.
 *  - Both bound the in-distro output with `head -c`, so a search over a huge
 *    tree fails as an overflow instead of buffering the world.
 *
 * Visible only in WSL sessions (`worlds: w => w.startsWith('wsl:')`), where
 * these definitions shadow the host search tools under the same names.
 *
 * Ported from dsh-wsl-workspace 0.7.3 `src/host/wsl-search.ts`
 * (https://github.com/6Mikao9/dsh-wsl-workspace, MIT).
 *
 * @module @deepseek-ai/dsh-world-wsl/tools-search
 */

import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  GLOB_MAX_RESULTS,
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_META_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  SearchError,
  formatGlobOutput,
  formatGrepMatches,
  formatGrepOutput,
  parseGlobArgs,
  parseGrepArgs,
  presentGlobCall,
  presentGlobResult,
  presentGrepCall,
  presentGrepResult,
  previewLine,
  sampleAcrossTopLevel,
  trySaveFormattedResult,
} from '@deepseek-ai/dsh-tool-fs-search'
import type { GrepMatch } from '@deepseek-ai/dsh-tool-fs-search'
import type { RetainedItems } from '@deepseek-ai/dsh-output-retention'
import { parseWorldRef } from '@deepseek-ai/dsh-world'
import type {} from '@deepseek-ai/dsh-world'
import { isAbsoluteLinuxPath, parseWslUnc, windowsToMntPath } from './paths.ts'
import { defaultDistroSync } from './wsl.ts'
import { getWorkspaceUsername } from './credentials.ts'

/**
 * The fixed `grep` script the distribution runs. Model-controlled values arrive
 * as positional parameters, so no value is ever parsed by a shell; `$0` is the
 * literal {@link SCRIPT_ARGV0} marker (not a path).
 *
 * `-r` recurses, `-n` numbers lines, `-I` skips binary files, `-E` is POSIX ERE,
 * `-H` forces the file name onto every record, and `-Z` terminates each file name
 * with NUL so the Node side can frame `path\0line:text` records unambiguously.
 *
 * The exclusions stand in for ripgrep's default hidden-entry skipping, which GNU
 * grep cannot express (it has no `.gitignore` support either). Three GNU quirks
 * shape how they are written, each measured against grep 3.12 on Ubuntu:
 *  - A file `--exclude` pattern silently cancels `--include` entirely, so the
 *    hidden-file guard rides `--include='[!.]*'` instead — and only when the
 *    caller passed no filter of its own (repeated includes are OR-ed) and only
 *    for a *directory* target, because a file the caller named explicitly is
 *    exactly what it asked for.
 *  - `--exclude-dir` excludes the search root itself when its base name starts
 *    with a dot, so that flag is skipped for a dot-rooted target.
 *  - `head -c` bounds the transfer in-distro, `PIPESTATUS[0]` keeps grep's own
 *    status rather than head's, and the search root is resolved physically first
 *    so a linked-in directory is searched where the file tools would read it.
 *
 * A distribution whose `grep` is not GNU's exits 3 with a diagnostic instead of
 * framing records the parser cannot read. Every mainstream WSL distribution
 * (Debian, Ubuntu, Fedora, Arch, openSUSE) ships GNU grep; Alpine's busybox grep
 * would report that clearly.
 */
const GREP_SCRIPT = [
  'set -u',
  'pattern=$1; include=$2; target=$3; cap=$4',
  '[ -n "$target" ] || target=.',
  'if [ -d "$target" ]; then',
  '  target=$(cd -- "$target" && pwd -P)',
  '  dir=1',
  'else',
  '  case $target in /*) ;; *) target=$PWD/$target ;; esac',
  '  dir=0',
  'fi',
  'if ! grep --version 2>/dev/null | head -n 1 | grep -q GNU; then',
  '  printf "grep is not GNU grep: %s\\n" "$(grep --version 2>/dev/null | head -n 1)" >&2',
  '  exit 3',
  'fi',
  'opts=(-rnIEH -Z)',
  'if [ "$dir" = 1 ]; then',
  '  opts+=(--exclude-dir=node_modules)',
  '  case ${target##*/} in .*) ;; *) opts+=(--exclude-dir=".*") ;; esac',
  '  [ -n "$include" ] || opts+=(--include="[!.]*")',
  'fi',
  'if [ -n "$include" ]; then',
  '  while IFS= read -r one; do [ -n "$one" ] && opts+=(--include="$one"); done <<<"$include"',
  'fi',
  'grep "${opts[@]}" --regexp="$pattern" -- "$target" | head -c "$cap"',
  'exit "${PIPESTATUS[0]}"',
].join('\n')

/**
 * The fixed `glob` script: an absolute file listing with modification times.
 *
 * `%T@` is the mtime in seconds (GNU find only), so the caller can order the
 * result the way ripgrep's `--sort=modified` does — oldest first — without a
 * stat per file and without a 9P round trip per file. VCS metadata directories
 * are pruned; the pattern itself is matched in Node.
 *
 * The header is `G`/`P` (GNU `-printf`, else the plain `-print0` fallback)
 * immediately followed by the physically resolved root, **NUL terminated** so a
 * path containing a newline cannot split it; every record after it is NUL framed
 * too. `PIPESTATUS[0]` is what the script exits with, because a `find` that
 * cannot read the target must not look like an empty directory.
 */
const GLOB_SCRIPT = [
  'set -u',
  'target=$1; cap=$2',
  '[ -n "$target" ] || target=.',
  'if [ -d "$target" ]; then target=$(cd -- "$target" && pwd -P); else',
  '  case $target in /*) ;; *) target=$PWD/$target ;; esac',
  'fi',
  'prune=(-name .git -o -name .hg -o -name .svn -o -name .bzr -o -name .jj -o -name .sl)',
  'if find --version 2>/dev/null | head -n 1 | grep -q GNU; then',
  "  { printf 'G%s\\0' \"$target\"; find \"$target\" \\( \"${prune[@]}\" \\) -prune -o -type f -printf '%T@\\t%p\\0'; } | head -c \"$cap\"",
  'else',
  "  { printf 'P%s\\0' \"$target\"; find \"$target\" \\( \"${prune[@]}\" \\) -prune -o -type f -print0; } | head -c \"$cap\"",
  'fi',
  'exit "${PIPESTATUS[0]}"',
].join('\n')

/** The marker `$0` of both scripts; a fixed string, never a path from the model. */
const SCRIPT_ARGV0 = 'dsh'

/** GNU grep stderr shapes that mean "the pattern is not a valid regex". */
const INVALID_PATTERN = new RegExp([
  'Unmatched',
  'Invalid (?:regular expression|range end|character class|back reference|preceding regular expression)',
  'unrecognized',
  'trailing backslash',
  'parentheses not balanced',
  'Invalid collating element',
].join('|'), 'i')

/** One grep match as the distribution reported it, in Linux coordinates. */
interface WslGrepRecord {
  /** Absolute Linux path, as `grep -r` printed it. */
  path: string
  /** 1-based line number. */
  lineNumber: number
  /** The matched line's text, trailing newline stripped. */
  line: string
}

/** One glob listing entry, in Linux coordinates. */
interface WslGlobRecord {
  /** Absolute Linux path. */
  path: string
  /** Modification time in milliseconds, or 0 when the listing carried none. */
  mtimeMs: number
}

/** How a glob listing was produced: GNU `-printf` (with mtimes) or a plain `-print0` fallback. */
type WslGlobMode = 'gnu' | 'plain'

/** A glob listing: the resolved search root plus its files. */
interface WslGlobListing {
  mode: WslGlobMode
  /** The physically resolved search root. */
  root: string
  files: WslGlobRecord[]
}

/** Where one search runs: the distribution, the Linux workdir, and the run-as user. */
interface WslSearchTarget {
  distro: string
  linuxCwd: string
  username?: string
}

/** The session's WSL search target from its world projection, or undefined when not in a WSL world. */
function wslSearchTarget(ctx: Context, exec: ToolRunContext): WslSearchTarget | undefined {
  const session = exec.agent?.session
  if (session === undefined) return undefined
  const world = ctx.get('sessionProjections')?.stateOf(session, 'world')
  if (world !== undefined) {
    try {
      const parsed = parseWorldRef(world)
      if (parsed.kind === 'wsl') {
        const unc = parseWslUnc(session.header.cwd ?? '')
        return {
          distro: parsed.distro,
          linuxCwd: unc?.linuxPath ?? '/',
          ...parsed.user === undefined ? {} : { username: parsed.user },
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }
  // A composition without the world projection (or a session older than it):
  // fall back to the upstream cwd chain.
  const cwd = session.header.cwd
  if (cwd === undefined || cwd === '') return undefined
  const unc = parseWslUnc(cwd)
  if (unc !== null) {
    const username = getWorkspaceUsername(cwd)
    return { distro: unc.distro, linuxCwd: unc.linuxPath === '' ? '/' : unc.linuxPath, ...username === undefined ? {} : { username } }
  }
  if (!isAbsoluteLinuxPath(cwd)) return undefined
  const distro = defaultDistroSync()
  if (distro === undefined || distro === '') return undefined
  return { distro, linuxCwd: cwd }
}

/**
 * Express a model-supplied search target in Linux coordinates: a WSL UNC path
 * becomes its Linux form, a Windows drive path becomes its `/mnt/<drive>` form
 * (the same translation the file tools apply), and everything else — absolute,
 * relative, empty — is used as typed and resolved by the distribution against
 * the session workdir.
 * @param path - the tool call's `path`, when given.
 * @returns the script's `target` parameter.
 */
function linuxTarget(path: string | undefined): string {
  if (path === undefined) return ''
  const unc = parseWslUnc(path)
  if (unc !== null) return unc.linuxPath === '' ? '/' : unc.linuxPath
  return windowsToMntPath(path) ?? path
}

/**
 * Build the `wsl.exe` argv for one search. Values ride as positional parameters
 * after the fixed script, so nothing the model typed is ever parsed by a shell.
 * @param target - where to run.
 * @param script - the fixed script.
 * @param values - the script's positional parameters.
 * @returns the complete argv vector.
 */
function buildWslArgv(
  target: WslSearchTarget,
  script: string,
  values: readonly string[],
): string[] {
  return [
    'wsl.exe',
    '-d', target.distro,
    ...target.username === undefined ? [] : ['-u', target.username],
    '--cd', target.linuxCwd,
    '-e', 'bash', '-c', script,
    SCRIPT_ARGV0,
    ...values,
  ]
}

/** One completed in-distro run: its exit code, raw stdout, stderr tail and kill signal. */
interface WslRun {
  code: number | null
  stdout: Buffer
  stderr: string
  aborted: boolean
  signal: NodeJS.Signals | null
}

/**
 * Run one fixed script inside the distribution.
 *
 * Errors stay in the host suite's two domains: a spawn failure (a missing
 * `wsl.exe`) rejects, while every completed or killed run comes back for the
 * caller to classify.
 * @param argv - the complete `wsl.exe` argv.
 * @param timeoutMs - the hard kill deadline.
 * @param rawOutputMaxBytes - the stdout budget the script already bounded.
 * @param signal - caller cancellation.
 * @returns the run outcome.
 */
function runInDistro(
  argv: readonly string[],
  timeoutMs: number,
  rawOutputMaxBytes: number,
  signal: AbortSignal | undefined,
): Promise<WslRun> {
  return new Promise<WslRun>((settle, fail) => {
    execFile(argv[0] ?? 'wsl.exe', [...argv.slice(1)], {
      // The script already bounds stdout in-distro; the seam keeps a little
      // slack so a bounded run can never trip the stream cap instead.
      maxBuffer: rawOutputMaxBytes + 1_048_576,
      encoding: 'buffer',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      ...signal === undefined ? {} : { signal },
    }, (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => {
      if (error === null) {
        settle({ code: 0, stdout, stderr: stderr.toString('utf8'), aborted: false, signal: null })
        return
      }
      const aborted = error.name === 'AbortError'
      const code = typeof error.code === 'number' ? error.code : null
      const killSignal = error.signal ?? null
      if (code === null && !aborted && killSignal === null) {
        // The command could not start at all (a missing wsl.exe, EACCES, …).
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- ExecFileException is an Error.
        fail(error)
        return
      }
      settle({ code, stdout, stderr: stderr.toString('utf8'), aborted, signal: killSignal })
    })
  })
}

/**
 * Classify one completed run into raw stdout or a `SEARCH_*` failure, using the
 * host suite's error vocabulary so retry/permission layers branch identically.
 *
 * The two engines disagree on exit 1: it is grep's "searched, found nothing",
 * while `find` returns non-zero when it could not read the target at all — which
 * must not be reported as an empty directory.
 * @param run - the completed run.
 * @param toolName - `grep` or `glob`, for the message.
 * @param rawOutputMaxBytes - the budget the script bounded stdout to.
 * @returns the raw stdout bytes.
 */
function acceptRun(run: WslRun, toolName: string, rawOutputMaxBytes: number): Buffer {
  if (run.aborted || run.signal !== null) {
    throw new SearchError(`${toolName} was cancelled or timed out before it finished`, 'SEARCH_ABORTED')
  }
  // The in-distro `head -c` cap is `rawOutputMaxBytes + 1`: one byte past the
  // budget is exactly the host suite's raw-output overflow condition.
  if (run.stdout.length > rawOutputMaxBytes) {
    throw new SearchError(
      `${toolName} produced more than ${rawOutputMaxBytes} bytes of raw output; narrow pattern or path`,
      'SEARCH_RAW_OUTPUT_OVERFLOW',
    )
  }
  if (toolName === 'grep' && run.code === 3) {
    throw new SearchError(`grep requires GNU grep inside the distribution: ${run.stderr.trim()}`, 'SEARCH_FAILED')
  }
  if (run.code !== 0 && !(toolName === 'grep' && run.code === 1)) {
    if (toolName === 'grep' && INVALID_PATTERN.test(run.stderr)) {
      throw new SearchError(`grep received an invalid regular expression: ${run.stderr.trim()}`, 'SEARCH_INVALID_PATTERN')
    }
    throw new SearchError(`${toolName} failed in the distribution (exit ${String(run.code)}): ${run.stderr.trim()}`, 'SEARCH_FAILED')
  }
  return run.stdout
}

/**
 * Frame a raw `grep -rnIE -Z` stdout buffer into matches.
 *
 * GNU grep prints `<path>\0<line>:<text>\n` per match, so splitting on NUL and
 * then on the first newline of each following segment recovers all three fields
 * even when a path contains spaces, colons or newlines (the text cannot, because
 * grep reports one line at a time and `-I` keeps NUL bytes out of the stream).
 * @param stdout - the complete raw stdout bytes.
 * @returns the matches in output order.
 */
export function parseGrepRecords(stdout: Buffer): WslGrepRecord[] {
  const records: WslGrepRecord[] = []
  const segments = stdout.toString('utf8').split('\u0000')
  let path = segments[0] ?? ''
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] ?? ''
    if (segment === '') continue
    const newline = segment.indexOf('\n')
    const head = newline < 0 ? segment : segment.slice(0, newline)
    const colon = head.indexOf(':')
    const lineNumber = Number.parseInt(colon < 0 ? head : head.slice(0, colon), 10)
    if (Number.isFinite(lineNumber)) {
      records.push({ path, lineNumber, line: colon < 0 ? '' : head.slice(colon + 1) })
    }
    // Resynchronize on the next NUL-framed path whether or not this segment
    // parsed: a truncated tail must not shift every later match.
    path = newline < 0 ? '' : segment.slice(newline + 1)
  }
  return records
}

/**
 * Frame a raw `glob` stdout buffer into a listing mode, a resolved root and
 * entries.
 *
 * The script prefixes its output with a NUL-terminated `<mode><root>` header
 * (`G` = GNU `-printf`: `mtime\tpath` records; `P` = plain `-print0`: paths only,
 * no modification times). NUL framing keeps a root whose own path contains a
 * newline in one piece.
 * @param stdout - the complete raw stdout bytes.
 * @returns the listing; `plain` entries carry `mtimeMs: 0`.
 */
export function parseGlobRecords(stdout: Buffer): WslGlobListing {
  const headerEnd = stdout.indexOf(0x00)
  const header = (headerEnd < 0 ? stdout : stdout.subarray(0, headerEnd)).toString('utf8')
  const mode: WslGlobMode = header.startsWith('G') ? 'gnu' : 'plain'
  const root = header.length > 0 ? header.slice(1) : ''
  const files: WslGlobRecord[] = []
  const body = headerEnd < 0 ? Buffer.alloc(0) : stdout.subarray(headerEnd + 1)
  for (const entry of body.toString('utf8').split('\u0000')) {
    if (entry === '') continue
    if (mode === 'plain') {
      files.push({ path: entry, mtimeMs: 0 })
      continue
    }
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const seconds = Number.parseFloat(entry.slice(0, tab))
    files.push({
      path: entry.slice(tab + 1),
      mtimeMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    })
  }
  return { mode, root, files }
}

/**
 * Expand one glob's `{a,b,c}` alternations into the equivalent list of plain
 * globs. ripgrep's globset understands braces; GNU grep's `--include` does not,
 * so the tool passes one `--include` per expansion (repeated includes are OR-ed).
 * @param glob - the glob to expand.
 * @returns every brace-free alternative, in source order.
 */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{')
  if (open < 0) return [glob]
  const close = glob.indexOf('}', open + 1)
  if (close < 0) return [glob]
  const head = glob.slice(0, open)
  const tail = glob.slice(close + 1)
  return glob.slice(open + 1, close).split(',').flatMap(part => expandBraces(`${head}${part}${tail}`))
}

/**
 * Translate one gitignore-style glob into a regular-expression source (no
 * anchors). `*` and `?` never cross a separator, `**` does (a `**` followed by a
 * separator also matches zero segments), `[...]` is a character class (negated
 * by a leading `!` or `^`), and `{a,b}` is an alternation.
 * @param pattern - the glob source.
 * @returns the unanchored regex source.
 */
function globSource(pattern: string): string {
  let source = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index] ?? ''
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]*/)*'
          index += 3
          continue
        }
        source += '.*'
        index += 2
        continue
      }
      source += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 2)
      if (close > index + 1) {
        const body = pattern.slice(index + 1, close)
        const negated = body.startsWith('!') || body.startsWith('^')
        const chars = (negated ? body.slice(1) : body).replace(/[\\^\]]/g, '\\$&')
        source += `[${negated ? '^' : ''}${chars}]`
        index = close + 1
        continue
      }
      source += '\\['
      index += 1
      continue
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index + 1)
      if (close > index + 1) {
        const alternatives = pattern.slice(index + 1, close).split(',').map(part => globSource(part))
        source += `(?:${alternatives.join('|')})`
        index = close + 1
        continue
      }
      source += '\\{'
      index += 1
      continue
    }
    source += /[.+^$()|\\]/.test(char) ? `\\${char}` : char
    index += 1
  }
  return source
}

/**
 * Compile one glob into a whole-string matcher.
 * @param pattern - the glob source.
 * @returns the anchored regular expression.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`)
}

/**
 * Whether one file passes a glob filter. A pattern containing `/` matches the
 * path relative to the search root; one without matches the basename at any
 * depth. A leading `!` negates the match, so `!*.log` keeps everything that is
 * not a log file.
 * @param pattern - the glob filter.
 * @param relativePath - the candidate's path relative to the search root.
 * @returns true when the file is selected.
 */
export function matchGlob(pattern: string, relativePath: string): boolean {
  let body = pattern
  let negated = false
  if (body.startsWith('!')) {
    negated = true
    body = body.slice(1)
  }
  const candidate = body.includes('/') ? relativePath : posix.basename(relativePath)
  const matched = globToRegExp(body).test(candidate)
  return negated ? !matched : matched
}

/**
 * Map one absolute Linux path to what the model should see: relative to the
 * session workdir when it is inside it, absolute otherwise. The POSIX twin of
 * the host suite's `toWorkdirRelative` (`path.relative` prints `src\a.ts`).
 * @param absolutePath - the search's absolute Linux path.
 * @param workdir - the session workdir in Linux coordinates.
 * @returns the display path.
 */
export function displayPath(absolutePath: string, workdir: string): string {
  const relative = posix.relative(workdir, absolutePath)
  if (relative === '') return '.'
  return relative.startsWith('..') || posix.isAbsolute(relative) ? absolutePath : relative
}

/** One retained page's structural subset (what the card projections read). */
interface RetainedPage<T> {
  items: T[]
  truncated: boolean
  seen: number
}

/**
 * Apply DSH's inline caps to a match list: preview each line and keep the first
 * `maxMatches` (the host suite's private `retainGrepMatches` outcome).
 * @param matches - every match the search parsed.
 * @param maxMatches - the inline match cap.
 * @param maxLineBytes - the per-line preview budget.
 * @returns the retention outcome, with exact omission metadata.
 */
export function retainMatches(
  matches: readonly GrepMatch[],
  maxMatches: number,
  maxLineBytes: number,
): RetainedItems<GrepMatch> {
  const items = matches.slice(0, Math.max(0, maxMatches)).map(match => ({
    ...match,
    line: previewLine(match.line, maxLineBytes),
  }))
  const omitted = Math.max(0, matches.length - items.length)
  return {
    items,
    truncated: omitted > 0,
    seen: matches.length,
    kept: items.length,
    omitted: omitted > 0 ? { kind: 'exact', count: omitted } : { kind: 'none' },
  }
}

/** The card metadata DSH's `present*Result` narrows back into a search view. */
type WslSearchMeta =
  | { shape: 'matches'; files: { path: string; matches: { lineNumber: number; line: string }[] }[]; truncated: boolean; total: number }
  | { shape: 'paths'; paths: string[]; truncated: boolean; total: number }

/** The serialized UTF-8 byte size of one card payload (the size persisted and re-sent). */
function metaBytes(meta: WslSearchMeta): number {
  return Buffer.byteLength(JSON.stringify(meta), 'utf8')
}

/**
 * Drop trailing file groups (or paths) until the serialized card metadata fits
 * `maxMetaBytes`, marking it truncated (the host suite's `capMetaBytes`:
 * `total` keeps counting what the search found, and a single oversized item
 * survives rather than producing an empty card).
 * @param meta - the projected metadata, already capped to the inline item count.
 * @param maxMetaBytes - the serialized byte budget.
 * @returns the same metadata when it fits, else a byte-bounded copy.
 */
export function capMetaBytes(meta: WslSearchMeta, maxMetaBytes: number): WslSearchMeta {
  if (metaBytes(meta) <= maxMetaBytes) return meta
  if (meta.shape === 'matches') {
    const files = [...meta.files]
    while (files.length > 1 && metaBytes({ ...meta, files, truncated: true }) > maxMetaBytes) files.pop()
    return { ...meta, files, truncated: true }
  }
  const paths = [...meta.paths]
  while (paths.length > 1 && metaBytes({ ...meta, paths, truncated: true }) > maxMetaBytes) paths.pop()
  return { ...meta, paths, truncated: true }
}

/**
 * Project a retained match page into the `matches`-shaped search card (first-seen
 * file order, then the byte cap).
 * @param page - the retained page (previewed, capped) or any equivalent subset.
 * @param maxMetaBytes - the serialized metadata budget.
 * @returns the card metadata.
 */
export function grepSearchMeta(page: RetainedPage<GrepMatch>, maxMetaBytes: number): WslSearchMeta {
  const byFile = new Map<string, { lineNumber: number; line: string }[]>()
  for (const match of page.items) {
    const entry = { lineNumber: match.lineNumber, line: match.line }
    const group = byFile.get(match.path)
    if (group === undefined) byFile.set(match.path, [entry])
    else group.push(entry)
  }
  return capMetaBytes({
    shape: 'matches',
    files: Array.from(byFile, ([path, matches]) => ({ path, matches })),
    truncated: page.truncated,
    total: page.seen,
  }, maxMetaBytes)
}

/**
 * Project a retained path page into the `paths`-shaped search card.
 * @param page - the retained page (capped) or any equivalent subset.
 * @param maxMetaBytes - the serialized metadata budget.
 * @returns the card metadata.
 */
export function globSearchMeta(page: RetainedPage<string>, maxMetaBytes: number): WslSearchMeta {
  return capMetaBytes({
    shape: 'paths',
    paths: [...page.items],
    truncated: page.truncated,
    total: page.seen,
  }, maxMetaBytes)
}

/**
 * Normalize a spill reference for rendering: rebuild a real `SpillRef` from
 * the schema-validated record, surviving a backend that omits the hint.
 * @param spill - the canonical value's spill record.
 * @returns a render-ready reference, or undefined when there is nothing to name.
 */
export function normalizeSpill(
  spill: { locator?: unknown; retrievalHint?: unknown; bytes?: unknown } | undefined | null,
): SpillRef | undefined {
  if (spill === undefined || spill === null) return undefined
  if (typeof spill.locator !== 'string' || spill.locator === '') return undefined
  return {
    locator: SpillLocator(spill.locator),
    retrievalHint: typeof spill.retrievalHint === 'string' ? spill.retrievalHint : '',
    bytes: typeof spill.bytes === 'number' ? spill.bytes : 0,
  }
}

/** The spill reference's schema: an object whose extra fields are the backend's business. */
const SPILL_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    locator: { type: 'string' },
    retrievalHint: { type: 'string' },
  },
} as const

/** The glob caps one render needs. */
interface GlobCaps {
  maxResults: number
  sampleOverCapGlobResults: boolean
}

/**
 * Format one capped `glob` page in the flat (head) style.
 * @param items - the page shown inline.
 * @param seen - how many paths the complete result holds.
 * @param spillRef - the saved complete-result reference, or undefined when unsaved.
 * @returns the model-facing text.
 */
function formatGlobPage(items: readonly string[], seen: number, spillRef: SpillRef | undefined): string {
  const recovery = spillRef !== undefined
    ? `Full sorted result stored at: ${spillRef.locator}. ${spillRef.retrievalHint}`
    : 'The complete result could not be saved; narrow pattern or path to see more.'
  return `${items.join('\n')}\n\n(Showing ${items.length} of ${seen} paths. ${recovery})`
}

/**
 * Format one `glob` result: whole when within the cap, else the
 * modification-time head or the top-level sample, with the same footer.
 * @param paths - the complete display-path list, in modification-time order.
 * @param caps - the inline cap and the sampling switch.
 * @param root - the search root in the same display-path space as `paths`.
 * @param spillRef - the saved complete-result reference, or undefined when unsaved.
 * @returns the model-facing text.
 */
export function renderGlobText(
  paths: readonly string[],
  caps: GlobCaps,
  root: string,
  spillRef?: SpillRef,
): string {
  if (paths.length === 0) return 'No files found'
  if (paths.length <= caps.maxResults) return paths.join('\n')
  if (!caps.sampleOverCapGlobResults) {
    return formatGlobPage(paths.slice(0, caps.maxResults), paths.length, spillRef)
  }
  return formatGlobOutput(sampleAcrossTopLevel([...paths], caps.maxResults, root), paths.length, spillRef)
}

/**
 * The inline page a `glob` card shows, computed the same way {@link renderGlobText}
 * computes its model page so text and card never disagree.
 * @param paths - the complete display-path list.
 * @param caps - the inline cap and the sampling switch.
 * @param root - the search root in the same display-path space as `paths`.
 * @returns the page and whether the complete result was capped.
 */
export function globCardPage(
  paths: readonly string[],
  caps: GlobCaps,
  root: string,
): { items: string[]; truncated: boolean } {
  if (paths.length <= caps.maxResults) return { items: [...paths], truncated: false }
  if (!caps.sampleOverCapGlobResults) return { items: paths.slice(0, caps.maxResults), truncated: true }
  return { items: sampleAcrossTopLevel([...paths], caps.maxResults, root).items, truncated: true }
}

/**
 * Format one `grep` result, including the zero-match wording.
 * @param matches - every match the search returned, with display paths.
 * @param caps - the inline caps.
 * @param spillRef - the saved complete-result reference, or undefined when unsaved.
 * @returns the model-facing text.
 */
export function renderGrepText(
  matches: readonly GrepMatch[],
  caps: { maxMatches: number; maxLineBytes: number },
  spillRef?: SpillRef,
): string {
  const retained = retainMatches(matches, caps.maxMatches, caps.maxLineBytes)
  if (retained.seen === 0) return 'No matches found'
  return formatGrepOutput(retained, spillRef)
}

/** Inline caps and engine budgets, read from the host suite's own constants. */
const GREP_CAPS = { maxMatches: GREP_MAX_MATCHES, maxLineBytes: GREP_MAX_LINE_BYTES, maxMetaBytes: SEARCH_META_MAX_BYTES }
const GLOB_CAPS = { maxResults: GLOB_MAX_RESULTS, sampleOverCapGlobResults: false }

/**
 * Register the WSL world's `grep` and `glob` tools.
 * @param ctx - the world-wsl plugin context.
 */
export function registerWslSearchTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'grep',
    description: `Search file contents inside this WSL distribution with a GNU grep extended regular expression. Returns matching lines with line numbers, grouped by file. Returns the first ${GREP_CAPS.maxMatches} matches inline; a capped result reports where the complete match list was saved. Use read on a matched file for surrounding context.`,
    worlds: world => world.startsWith('wsl:'),
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression to search for (GNU grep -E syntax: \\d, \\w, \\b and (?i) work; lookaround and backreferences do not).',
      },
      path: {
        type: 'string',
        description: 'File or Linux path to search. Defaults to the session workspace; a relative path resolves against it.',
      },
      include: {
        type: 'string',
        description: 'One glob filter on file names for which files to search (e.g. "*.ts", "*.{js,jsx}"). A filter containing "/" is matched against the path relative to the search root. Not a list; negation is not supported.',
      },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
          spill: SPILL_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderGrepText(value.matches, GREP_CAPS, normalizeSpill(value.spill)),
      }],
      presentationMeta: (_args, value) => (
        grepSearchMeta(retainMatches(value.matches, GREP_CAPS.maxMatches, GREP_CAPS.maxLineBytes), GREP_CAPS.maxMetaBytes)
      ),
    },
    async execute(args, exec) {
      const input = parseGrepArgs(args)
      const target = wslSearchTarget(ctx, exec)
      if (target === undefined) {
        throw new SearchError('grep is only available in a WSL workspace session', 'SEARCH_FAILED')
      }
      // GNU grep's `--include` matches file NAMES; a path-shaped filter (`src/*.ts`,
      // ripgrep semantics) is therefore applied here, over the relative path, and
      // no in-distro filter is passed at all — repeated includes are OR-ed, so
      // mixing the two would silently drop the path-shaped half.
      const globs = expandBraces(input.include ?? '')
      const pathShaped = globs.filter(glob => glob.includes('/'))
      const argv = buildWslArgv(
        target,
        GREP_SCRIPT,
        [
          input.pattern,
          pathShaped.length > 0 ? '' : globs.join('\n'),
          linuxTarget(input.path),
          String(RAW_OUTPUT_MAX_BYTES + 1),
        ],
      )
      const run = await runInDistro(argv, SEARCH_TIMEOUT_MS, RAW_OUTPUT_MAX_BYTES, exec.signal)
      const stdout = acceptRun(run, 'grep', RAW_OUTPUT_MAX_BYTES)
      const matches: GrepMatch[] = parseGrepRecords(stdout)
        .filter((record) => {
          if (pathShaped.length === 0) return true
          const relative = posix.relative(target.linuxCwd, record.path)
          const candidate = relative.startsWith('..') ? record.path : relative
          return pathShaped.some(glob => matchGlob(glob, candidate))
        })
        .map(record => ({
          path: displayPath(record.path, target.linuxCwd),
          lineNumber: record.lineNumber,
          line: record.line,
        }))
      if (matches.length <= GREP_CAPS.maxMatches) return { matches }
      const previewed = matches.map(match => ({ ...match, line: previewLine(match.line, GREP_CAPS.maxLineBytes) }))
      const spill = await trySaveFormattedResult(
        ctx,
        exec,
        'grep-results.txt',
        `Found ${matches.length} matches\n\n${formatGrepMatches(previewed)}`,
      )
      return spill === undefined
        ? { matches }
        : { matches, spill: { locator: String(spill.locator), bytes: spill.bytes, retrievalHint: spill.retrievalHint } }
    },
    presentCall: presentGrepCall,
    presentResult: presentGrepResult,
  }))

  const overCap = GLOB_CAPS.sampleOverCapGlobResults
    ? `a larger result instead returns ${GLOB_CAPS.maxResults} paths sampled across top-level entries`
    : `a larger result returns the first ${GLOB_CAPS.maxResults} paths in modification-time order`
  ctx.tools.register(defineTool({
    name: 'glob',
    description: `Find files inside this WSL distribution whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded). Up to ${GLOB_CAPS.maxResults} paths come back in modification-time order (oldest first); ${overCap}, says so, and reports where the complete sorted list was saved. This tool does not enumerate directory entries.`,
    worlds: world => world.startsWith('wsl:'),
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth. A leading "!" negates the pattern.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.',
      },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
          spill: SPILL_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderGlobText(value.paths, GLOB_CAPS, value.root, normalizeSpill(value.spill)),
      }],
      presentationMeta: (_args, value) => {
        const page = globCardPage(value.paths, GLOB_CAPS, value.root)
        return globSearchMeta({
          items: page.items,
          truncated: page.truncated,
          seen: value.paths.length,
        }, GLOB_MAX_META_BYTES)
      },
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args)
      const target = wslSearchTarget(ctx, exec)
      if (target === undefined) {
        throw new SearchError('glob is only available in a WSL workspace session', 'SEARCH_FAILED')
      }
      const argv = buildWslArgv(
        target,
        GLOB_SCRIPT,
        [linuxTarget(input.path), String(RAW_OUTPUT_MAX_BYTES + 1)],
      )
      const run = await runInDistro(argv, SEARCH_TIMEOUT_MS, RAW_OUTPUT_MAX_BYTES, exec.signal)
      const stdout = acceptRun(run, 'glob', RAW_OUTPUT_MAX_BYTES)
      const listing = parseGlobRecords(stdout)
      const rootAbsolute = listing.root === '' ? target.linuxCwd : listing.root
      // ripgrep's `--sort=modified` orders oldest first, so the modification-time
      // head is the oldest file; the plain fallback has no mtimes and orders by path.
      listing.files.sort(listing.mode === 'gnu'
        ? (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path)
        : (left, right) => left.path.localeCompare(right.path))
      const root = input.path === undefined ? '.' : displayPath(rootAbsolute, target.linuxCwd)
      const paths: string[] = []
      for (const file of listing.files) {
        const relative = posix.relative(rootAbsolute, file.path)
        if (!matchGlob(input.pattern, relative === '' ? posix.basename(file.path) : relative)) continue
        paths.push(displayPath(file.path, target.linuxCwd))
      }
      if (paths.length <= GLOB_CAPS.maxResults) return { root, paths }
      const spill = await trySaveFormattedResult(
        ctx,
        exec,
        'glob-results.txt',
        paths.join('\n'),
      )
      return spill === undefined
        ? { root, paths }
        : { root, paths, spill: { locator: String(spill.locator), bytes: spill.bytes, retrievalHint: spill.retrievalHint } }
    },
    presentCall: presentGlobCall,
    presentResult: presentGlobResult,
  }))
}

/** The search-card metadata byte budget (the host suite's own constant). */
const GLOB_MAX_META_BYTES = SEARCH_META_MAX_BYTES
