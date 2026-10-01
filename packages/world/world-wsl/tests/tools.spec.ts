/**
 * Tests for the WSL world's model-facing tools: bash argv/cwd translation,
 * the search engine's record framing and glob matcher, and the tools'
 * world-affinity visibility (registered once, visible only in WSL sessions).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import WorldRegistry, { setSessionWorld } from '@deepseek-ai/dsh-world'
import { registerWslBashTool } from '@deepseek-ai/dsh-world-wsl/src/tools-bash.ts'
import { expandBraces, globToRegExp, matchGlob, parseGlobRecords, parseGrepRecords } from '@deepseek-ai/dsh-world-wsl/src/tools-search.ts'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { WorldBackend } from '@deepseek-ai/dsh-world'

describe('search engine framing', () => {
  const NUL = '\u0000'

  it('frames NUL-separated grep records, resynchronizing after a truncated tail', () => {
    const stdout = Buffer.from(`/home/u/b.ts${NUL}7:let y\n`, 'utf8')
    expect(parseGrepRecords(stdout)).toEqual([
      { path: '/home/u/b.ts', lineNumber: 7, line: 'let y' },
    ])
  })

  it('frames a GNU glob listing with mtimes and a plain fallback', () => {
    const gnu = Buffer.from(`G/home/u${NUL}1700000000.5\t/home/u/a.ts${NUL}1699000000\t/home/u/b.ts${NUL}`, 'utf8')
    expect(parseGlobRecords(gnu)).toEqual({
      mode: 'gnu',
      root: '/home/u',
      files: [
        { path: '/home/u/a.ts', mtimeMs: 1700000000500 },
        { path: '/home/u/b.ts', mtimeMs: 1699000000000 },
      ],
    })
    const plain = Buffer.from(`P/home/u${NUL}/home/u/only.ts${NUL}`, 'utf8')
    expect(parseGlobRecords(plain)).toEqual({
      mode: 'plain',
      root: '/home/u',
      files: [{ path: '/home/u/only.ts', mtimeMs: 0 }],
    })
  })

  it('expands braces and matches globs with ripgrep semantics', () => {
    expect(expandBraces('*.{ts,js}')).toEqual(['*.ts', '*.js'])
    expect(expandBraces('src/*.{test,spec}.{ts,js}')).toEqual(['src/*.test.ts', 'src/*.test.js', 'src/*.spec.ts', 'src/*.spec.js'])
    expect(matchGlob('*.ts', 'src/deep/a.ts')).toBe(true)
    expect(matchGlob('*.ts', 'src/deep/a.js')).toBe(false)
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchGlob('src/*.ts', 'src/deep/a.ts')).toBe(false)
    expect(matchGlob('src/**/*.ts', 'src/deep/a.ts')).toBe(true)
    expect(matchGlob('!*.log', 'a.ts')).toBe(true)
    expect(matchGlob('!*.log', 'a.log')).toBe(false)
    expect(globToRegExp('**/*.ts').test('a/b/c.ts')).toBe(true)
  })
})

/** A recording subprocess provider for the WSL backend the bash tool routes to. */
function recordingBackend(): { backend: WorldBackend; spawns: SubprocessSpawnSpec[] } {
  const spawns: SubprocessSpawnSpec[] = []
  const subprocess = Object.create(null) as SubprocessRuntime
  subprocess.spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    spawns.push(spec)
    return Object.assign(Object.create(null) as SubprocessHandle, {
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {},
    })
  }
  return {
    spawns,
    backend: {
      ref: 'wsl:Ubuntu',
      displayName: 'Ubuntu (WSL)',
      ownsPath: path => path.startsWith('/home/') || path.startsWith('\\\\wsl.localhost\\Ubuntu\\'),
      detectFromCwd: cwd => (cwd.startsWith('/home/') || cwd.startsWith('\\\\wsl.localhost\\Ubuntu\\') ? 'wsl:Ubuntu' : null),
      fs: Object.create(null) as WorldBackend['fs'],
      subprocess,
    },
  }
}

async function mounted(backend: WorldBackend): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WorldRegistry)
  ctx.worlds.register(backend)
  registerWslBashTool(ctx)
  return ctx
}

describe('wsl bash tool', () => {
  const signal = new AbortController().signal

  it('is visible only in a WSL session, where it shadows the same name', async () => {
    const { backend } = recordingBackend()
    const ctx = await mounted(backend)
    const sessionId = SessionId('sess-bash')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: 'C:\\work' } })
    const agent = { session } as unknown as Agent

    // A local session: the wsl tool hides.
    expect(ctx.tools.get('bash', agent)).toBeUndefined()
    setSessionWorld(session, 'wsl:Ubuntu')
    expect(ctx.tools.get('bash', agent)).toBeDefined()
  })

  it('spawns bash -lc with an explicit cd prefix into the workdir, inside the session distribution', async () => {
    const { backend, spawns } = recordingBackend()
    const ctx = await mounted(backend)
    const sessionId = SessionId('sess-bash-run')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u' } })
    setSessionWorld(session, 'wsl:Ubuntu')
    const agent = { session } as unknown as Agent

    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('c1'),
      name: 'bash',
      arguments: { command: 'git status', description: 'Show working tree status', workdir: '/home/u/project' },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(spawns).toHaveLength(1)
    const spec = spawns[0]!
    expect(spec.argv).toEqual(['bash', '-lc', "cd '/home/u/project' && git status"])
    expect(spec.cwd).toBe('/home/u/project')
    expect(spec.env).toMatchObject({ NO_COLOR: '1', TERM: 'dumb' })
    const first = result.content[0]
    expect(first?.type === 'text' && first.text).toContain('[exit code: 0]')
  })

  it('rejects outside a WSL session', async () => {
    const { backend } = recordingBackend()
    const ctx = await mounted(backend)
    const sessionId = SessionId('sess-bash-local')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: 'C:\\work' } })
    const agent = { session } as unknown as Agent
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('c2'),
      name: 'bash',
      arguments: { command: 'true', description: 'Run true' },
      agent,
    })
    expect(result.isError).toBe(true)
  })
})
