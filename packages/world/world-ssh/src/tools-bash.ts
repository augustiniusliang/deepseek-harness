/**
 * The SSH world's `bash` tool: the model writes ordinary bash and the command
 * runs on the session's remote host as `bash -lc 'cd <dir> && <command>'`
 * through the session's world backend (pooled persistent connection). Visible
 * only in SSH sessions (`worlds: w => w.startsWith('ssh:')`), where it
 * shadows the host's shell tool under the same name.
 *
 * Output shape and rendering mirror `dsh-tool-bash`'s foreground result, so
 * the model reads identical semantics. Background execution and sandbox
 * escalation stay with the host tool; an SSH session's commands run under the
 * world's own fs fence (`enforcement: 'partial'`).
 *
 * @module @deepseek-ai/dsh-world-ssh/tools-bash
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { parseWorldRef } from '@deepseek-ai/dsh-world'
import type {} from '@deepseek-ai/dsh-world'
import { shellQuote } from './ssh.ts'

/** Model-friendly environment overrides (mirrors dsh-tool-bash's set). */
const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/** Foreground defaults (mirrors dsh-tool-bash's configured defaults). */
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 64_000
const GRACE_MS = 3_000

/** The tool's foreground result, the `dsh-tool-bash` foreground shape minus sandbox/background fields. */
interface SshBashResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
}

// jscpd:ignore-start -- world bash mirrors the host suite's output shapes and rendering verbatim (world-wsl shares the plumbing)
/** The session's SSH backend coordinates, or undefined when the session is not in an SSH world. */
function sshSession(ctx: Context, exec: ToolRunContext): { backendSubprocess: import('@deepseek-ai/dsh-subprocess').SubprocessRuntime } | undefined {
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
  return { backendSubprocess: backend.subprocess }
}

/** Render one foreground result exactly like the host bash tool's render (minus sandbox markers). */
function renderSshResult(result: SshBashResult): string {
  const out = result.stdout.truncated && result.stdout.spillPath !== undefined
    ? `${result.stdout.text}\n[output truncated; full output: ${result.stdout.spillPath}]`
    : result.stdout.text
  const err = result.stderr.truncated && result.stderr.spillPath !== undefined
    ? `${result.stderr.text}\n[output truncated; full output: ${result.stderr.spillPath}]`
    : result.stderr.text
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) markers.push(`[killed by signal: ${result.signal}]`)
  markers.push(`[exit code: ${result.exitCode ?? 'null'}]`)
  return markers.length === 0 ? body : `${body}\n\n${markers.join('\n')}`
}

/**
 * Register the SSH world's bash tool.
 * @param ctx - the world-ssh plugin context (its `worlds` and projections read through it).
 */
export function registerSshBashTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Execute a bash command on this SSH remote host (`bash -lc`) and return its stdout/stderr. '
      + 'Each call runs in a fresh shell; pass `workdir` instead of using `cd`. '
      + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available.',
    worlds: world => world.startsWith('ssh:'),
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to execute.' },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
          + '"git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds. The tool applies its default and cap, and kills the command on expiry.',
      },
      workdir: { type: 'string', description: 'Working directory for this command (remote Linux path). Defaults to the session workspace; a relative path is resolved against it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          timeoutMs: { type: 'number', required: true },
          stdout: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              spillPath: { type: 'string' },
            },
          },
          stderr: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              spillPath: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSshResult(value) }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      const target = sshSession(ctx, exec)
      if (session === undefined || target === undefined) {
        throw new Error('bash: this SSH tool runs only in an SSH workspace session')
      }
      const timeoutMs = clampTimeout(args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'bash: timeoutMs')
      const workdir = args.workdir === undefined || args.workdir.trim() === ''
        ? session.header.cwd ?? '/'
        : args.workdir
      using d = deadline(exec.signal, timeoutMs, 'SSH_BASH_TIMEOUT')
      const handle = target.backendSubprocess.spawn({
        argv: ['bash', '-lc', args.command],
        cwd: workdir,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: 64 * 1024 * 1024 } },
          stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: 64 * 1024 * 1024 } },
        },
        graceMs: GRACE_MS,
        signal: d.signal,
        env: ENV_OVERRIDES,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      const timedOut = timeoutOf(d.signal, 'SSH_BASH_TIMEOUT') !== undefined
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut,
        timeoutMs,
        stdout: {
          text: stdout?.text ?? '',
          truncated: stdout?.lossy ?? false,
          ...stdout?.spillPath !== undefined ? { spillPath: stdout.spillPath } : {},
        },
        stderr: {
          text: stderr?.text ?? '',
          truncated: stderr?.lossy ?? false,
          ...stderr?.spillPath !== undefined ? { spillPath: stderr.spillPath } : {},
        },
      } satisfies SshBashResult
    },
  }))
}

/* jscpd:ignore-end */

/** Re-export for the search tools: POSIX single-quote via the shared helper. */
export { shellQuote, posix }
