/**
 * The SSH world's `grep` / `glob` tools: the host search suite's model-facing
 * contract (same names, parameters, caps, rendering, presenters, and cards)
 * executed ON the remote host (GNU grep / GNU find behind the fixed
 * positional-argv scripts the WSL engine established), so searches run on the
 * remote kernel over the real tree instead of crossing the link per file.
 *
 * The engine pieces (scripts, framing, matching, rendering) are shared from
 * `@deepseek-ai/dsh-world-wsl`'s search module; this module supplies the SSH
 * target resolution and transport (the session's backend over the pool).
 *
 * @module @deepseek-ai/dsh-world-ssh/tools-search
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  GREP_MAX_LINE_BYTES,
  GREP_MAX_MATCHES,
  GLOB_MAX_RESULTS,
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_META_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  SearchError,
  formatGrepMatches,
  parseGlobArgs,
  parseGrepArgs,
  presentGlobCall,
  presentGlobResult,
  presentGrepCall,
  presentGrepResult,
  previewLine,
  trySaveFormattedResult,
} from '@deepseek-ai/dsh-tool-fs-search'
import type { GrepMatch } from '@deepseek-ai/dsh-tool-fs-search'
import { parseWorldRef } from '@deepseek-ai/dsh-world'
import type {} from '@deepseek-ai/dsh-world'
import {
  GREP_SCRIPT,
  GLOB_SCRIPT,
  displayPath,
  expandBraces,
  globCardPage,
  globSearchMeta,
  grepSearchMeta,
  matchGlob,
  normalizeSpill,
  parseGlobRecords,
  parseGrepRecords,
  renderGlobText,
  renderGrepText,
  retainMatches,
} from '@deepseek-ai/dsh-world-wsl/src/tools-search.ts'

/** Inline caps and engine budgets, read from the host suite's own constants. */
const GREP_CAPS = { maxMatches: GREP_MAX_MATCHES, maxLineBytes: GREP_MAX_LINE_BYTES, maxMetaBytes: SEARCH_META_MAX_BYTES }
const GLOB_CAPS = { maxResults: GLOB_MAX_RESULTS, sampleOverCapGlobResults: false }

/** Where one search runs: the backend and the remote workdir. */
interface SshSearchTarget {
  backendSubprocess: import('@deepseek-ai/dsh-subprocess').SubprocessRuntime
  remoteCwd: string
}

/** The session's SSH search target from its world projection, or undefined when not in an SSH world. */
function sshSearchTarget(ctx: Context, exec: ToolRunContext): SshSearchTarget | undefined {
  const session = exec.agent?.session
  if (session === undefined) return undefined
  const world = ctx.get('sessionProjections')?.stateOf(session, 'world')
  if (world === undefined) return undefined
  try {
    if (parseWorldRef(world).kind !== 'ssh') return undefined
  } catch {
    return undefined
  }
  const backend = ctx.get('worlds')?.backendOf(world)
  if (backend === undefined) return undefined
  return { backendSubprocess: backend.subprocess, remoteCwd: session.header.cwd ?? '/' }
}

/**
 * Express a model-supplied search target in remote coordinates: a Linux
 * absolute path as typed, everything else resolved by the remote against the
 * session workdir.
 * @param path - the tool call's `path`, when given.
 * @returns the script's `target` parameter.
 */
function remoteTarget(path: string | undefined): string {
  if (path === undefined) return ''
  return path
}

/**
 * Run one fixed engine script on the remote host through the session backend.
 * @param target - where to run.
 * @param script - the fixed script (GREP_SCRIPT/GLOB_SCRIPT).
 * @param values - the script's positional parameters.
 * @param exec - the tool execution (cancellation).
 * @returns the run's raw stdout.
 */
async function runScript(
  target: SshSearchTarget,
  script: string,
  values: readonly string[],
  exec: ToolRunContext,
): Promise<{ stdout: string; exitCode: number | null; stderr: string }> {
  const handle = target.backendSubprocess.spawn({
    argv: ['bash', '-c', script, 'dsh', ...values],
    cwd: target.remoteCwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: RAW_OUTPUT_MAX_BYTES + 1_048_576, spill: { maxBytes: RAW_OUTPUT_MAX_BYTES } },
      stderr: { maxBytes: 64_000, spill: { maxBytes: 64_000 } },
    },
    graceMs: 3_000,
    signal: exec.signal,
  })
  const outcome = await handle.done
  return {
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    exitCode: outcome.exitCode,
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

/**
 * Classify one completed run into raw stdout or a `SEARCH_*` failure, using the
 * host suite's error vocabulary so retry/permission layers branch identically.
 * The two engines disagree on exit 1: it is grep's "searched, found nothing",
 * while `find` returns non-zero when it could not read the target at all.
 * @param run - the completed run.
 * @param toolName - `grep` or `glob`, for the message.
 * @returns the raw stdout.
 */
function acceptRun(run: { stdout: string; exitCode: number | null; stderr: string }, toolName: string): string {
  if (run.exitCode === null) {
    throw new SearchError(`${toolName} was cancelled or timed out before it finished`, 'SEARCH_ABORTED')
  }
  // The in-distro `head -c` cap is `RAW_OUTPUT_MAX_BYTES + 1`: one byte past
  // the budget is exactly the host suite's raw-output overflow condition.
  if (run.stdout.length > RAW_OUTPUT_MAX_BYTES) {
    throw new SearchError(
      `${toolName} produced more than ${RAW_OUTPUT_MAX_BYTES} bytes of raw output; narrow pattern or path`,
      'SEARCH_RAW_OUTPUT_OVERFLOW',
    )
  }
  if (run.exitCode !== 0 && !(toolName === 'grep' && run.exitCode === 1)) {
    throw new SearchError(
      `${toolName} failed on the remote host (exit ${String(run.exitCode)}): ${run.stderr.trim()}`,
      'SEARCH_FAILED',
    )
  }
  return run.stdout
}

// jscpd:ignore-start -- world grep/glob mirror the host suite's schemas and presenters verbatim (world-wsl shares the plumbing)
/**
 * Register the SSH world's `grep` and `glob` tools.
 * @param ctx - the world-ssh plugin context.
 */
export function registerSshSearchTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'grep',
    description: `Search file contents on this SSH remote host with a GNU grep extended regular expression. Returns matching lines with line numbers, grouped by file. Returns the first ${GREP_CAPS.maxMatches} matches inline; a capped result reports where the complete match list was saved. Use read on a matched file for surrounding context.`,
    worlds: world => world.startsWith('ssh:'),
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression to search for (GNU grep -E syntax: \\d, \\w, \\b and (?i) work; lookaround and backreferences do not).',
      },
      path: {
        type: 'string',
        description: 'File or remote Linux path to search. Defaults to the session workspace; a relative path resolves against it.',
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
          spill: {
            type: 'object',
            additionalProperties: true,
            properties: {
              locator: { type: 'string' },
              retrievalHint: { type: 'string' },
            },
          },
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
      const target = sshSearchTarget(ctx, exec)
      if (target === undefined) {
        throw new SearchError('grep is only available in an SSH workspace session', 'SEARCH_FAILED')
      }
      const globs = expandBraces(input.include ?? '')
      const pathShaped = globs.filter(glob => glob.includes('/'))
      const run = await runScript(
        target,
        GREP_SCRIPT,
        [
          input.pattern,
          pathShaped.length > 0 ? '' : globs.join('\n'),
          remoteTarget(input.path),
          String(RAW_OUTPUT_MAX_BYTES + 1),
        ],
        exec,
      )
      const stdout = acceptRun(run, 'grep')
      const matches: GrepMatch[] = parseGrepRecords(Buffer.from(stdout, 'utf8'))
        .filter((record) => {
          if (pathShaped.length === 0) return true
          const relative = posix.relative(target.remoteCwd, record.path)
          const candidate = relative.startsWith('..') ? record.path : relative
          return pathShaped.some(glob => matchGlob(glob, candidate))
        })
        .map(record => ({
          path: displayPath(record.path, target.remoteCwd),
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
    description: `Find files on this SSH remote host whose paths match a glob pattern. Returns matching file paths — never directories — including hidden and ignored files (VCS metadata directories are excluded). Up to ${GLOB_CAPS.maxResults} paths come back in modification-time order (oldest first); ${overCap}, says so, and reports where the complete sorted list was saved. This tool does not enumerate directory entries.`,
    worlds: world => world.startsWith('ssh:'),
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth. A leading "!" negates the pattern.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (remote Linux path). Defaults to the session workspace; a relative path resolves against it.',
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
          spill: {
            type: 'object',
            additionalProperties: true,
            properties: {
              locator: { type: 'string' },
              retrievalHint: { type: 'string' },
            },
          },
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
        }, SEARCH_META_MAX_BYTES)
      },
    },
    async execute(args, exec) {
      const input = parseGlobArgs(args)
      const target = sshSearchTarget(ctx, exec)
      if (target === undefined) {
        throw new SearchError('glob is only available in an SSH workspace session', 'SEARCH_FAILED')
      }
      const run = await runScript(
        target,
        GLOB_SCRIPT,
        [remoteTarget(input.path), String(RAW_OUTPUT_MAX_BYTES + 1)],
        exec,
      )
      const stdout = acceptRun(run, 'glob')
      const listing = parseGlobRecords(Buffer.from(stdout, 'utf8'))
      const rootAbsolute = listing.root === '' ? target.remoteCwd : listing.root
      listing.files.sort(listing.mode === 'gnu'
        ? (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path)
        : (left, right) => left.path.localeCompare(right.path))
      const root = input.path === undefined ? '.' : displayPath(rootAbsolute, target.remoteCwd)
      const paths: string[] = []
      for (const file of listing.files) {
        const relative = posix.relative(rootAbsolute, file.path)
        if (!matchGlob(input.pattern, relative === '' ? posix.basename(file.path) : relative)) continue
        paths.push(displayPath(file.path, target.remoteCwd))
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
/* jscpd:ignore-end */
