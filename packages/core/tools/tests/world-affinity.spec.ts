/**
 * World-affinity visibility: one tool name may hold an affinity-free base plus
 * world-affinity variants, and the registry's installed world resolver picks
 * the definition a session sees — matching variant, else the base, else
 * nothing. This is the seam execution worlds register their shell/search
 * tools through.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, WorldAffinity } from '@deepseek-ai/dsh-tools'

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

function tool(name: string, reply: string, worlds?: WorldAffinity): ToolDefinition {
  return {
    name,
    description: `tool ${name} (${reply})`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    ...worlds === undefined ? {} : { worlds },
    execute: (): Promise<string> => Promise.resolve(reply),
  }
}

/** A scope key whose world the test resolver reads directly. */
function scopeWithWorld(world: string): { world: string } {
  return { world }
}

describe('tool world affinity', () => {
  it('selects the matching variant, else the base, else nothing', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('probe', 'base'))
    ctx.tools.register(tool('probe', 'wsl', world => world.startsWith('wsl:')))
    ctx.tools.register(tool('host-shell', 'pwsh', 'local'))
    const restore = ctx.tools.registerWorldResolver(scope => (scope as { world: string }).world)

    const local = scopeWithWorld('local')
    expect(ctx.tools.get('probe', local)?.description).toBe('tool probe (base)')
    expect(ctx.tools.get('host-shell', local)?.description).toBe('tool host-shell (pwsh)')

    const wsl = scopeWithWorld('wsl:Ubuntu')
    expect(ctx.tools.get('probe', wsl)?.description).toBe('tool probe (wsl)')
    // The 'local'-tagged host tool is hidden outside the local world.
    expect(ctx.tools.get('host-shell', wsl)).toBeUndefined()

    // No matching variant: the affinity-free base serves every other world.
    const ssh = scopeWithWorld('ssh:prod')
    expect(ctx.tools.get('probe', ssh)?.description).toBe('tool probe (base)')
    restore()
    // The default resolver answers 'local' again.
    expect(ctx.tools.get('host-shell', scopeWithWorld('wsl:Ubuntu'))?.description).toBe('tool host-shell (pwsh)')
  })

  it('keeps the duplicate-name error for two affinity-free registrations', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('probe', 'base'))
    expect(() => ctx.tools.register(tool('probe', 'second'))).toThrow('tool "probe" is already registered')
    // ...but a variant with an affinity coexists, and disposing it restores the base.
    const dispose = ctx.tools.register(tool('probe', 'wsl', world => world.startsWith('wsl:')))
    const wsl = scopeWithWorld('wsl:Ubuntu')
    const restore = ctx.tools.registerWorldResolver(scope => (scope as { world: string }).world)
    expect(ctx.tools.get('probe', wsl)?.description).toBe('tool probe (wsl)')
    dispose()
    expect(ctx.tools.get('probe', wsl)?.description).toBe('tool probe (base)')
    restore()
  })

  it('rejects a malformed worlds declaration at registration', async () => {
    const ctx = await mount()
    expect(() => ctx.tools.register({
      ...tool('bad', 'x'),
      worlds: 'wsl:*' as unknown as WorldAffinity,
    })).toThrow('tool "bad" worlds must be "local" or a (world: string) => boolean predicate')
  })
})
