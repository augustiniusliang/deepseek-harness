/**
 * Tests for the WSL world backend: the ported path helpers, the credential
 * store, the backend's path ownership and cwd detection, and the subprocess
 * spawn/terminal translation. Host-dependent parts (wsl.exe) are stubbed.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  createWslWorldBackend,
  canonicalWindowsPath,
  getWindowsWorkspace,
  getWorkspaceUsername,
  isAbsoluteLinuxPath,
  isValidWslUsername,
  isWslUnc,
  joinUnc,
  mntToWindowsPath,
  parseWslUnc,
  registerWindowsWorkspace,
  resolveRelayPath,
  setWorkspaceUsername,
  uncToLinux,
  windowsToMntPath,
} from '@deepseek-ai/dsh-world-wsl'

describe('paths', () => {
  it.each([
    ['\\\\wsl.localhost\\Ubuntu\\home\\u', { distro: 'Ubuntu', linuxPath: '/home/u' }],
    ['\\\\wsl$\\Ubuntu\\home\\u', { distro: 'Ubuntu', linuxPath: '/home/u' }],
    ['//wsl.localhost/Ubuntu/home/u/', { distro: 'Ubuntu', linuxPath: '/home/u' }],
    ['\\\\wsl.localhost\\Ubuntu', { distro: 'Ubuntu', linuxPath: '/' }],
  ] as const)('parses %s', (raw, expected) => {
    expect(parseWslUnc(raw)).toEqual(expected)
    expect(isWslUnc(raw)).toBe(true)
  })

  it.each([
    'C:\\work',
    '\\\\server\\share\\dir',
    '\\\\wsl.localhost\\',
    '/home/u',
    'relative/path',
  ])('rejects %s as a WSL UNC', (raw) => {
    expect(parseWslUnc(raw)).toBeNull()
    expect(isWslUnc(raw)).toBe(false)
  })

  it('joins distro and Linux path into the canonical UNC and back', () => {
    const unc = joinUnc('Ubuntu', '/home/u/project')
    expect(unc).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u\\project')
    expect(uncToLinux(unc)).toBe('/home/u/project')
    expect(() => joinUnc('bad/distro', '/x')).toThrow('invalid distribution name')
    expect(() => joinUnc('Ubuntu', 'relative')).toThrow('non-absolute Linux path')
    expect(() => uncToLinux('C:\\work')).toThrow('is not a WSL UNC path')
  })

  it('maps drive paths to /mnt and back', () => {
    expect(windowsToMntPath('C:\\work\\dir\\')).toBe('/mnt/c/work/dir')
    expect(windowsToMntPath('d:/x')).toBe('/mnt/d/x')
    expect(windowsToMntPath('\\\\wsl$\\Ubuntu\\home')).toBeNull()
    expect(mntToWindowsPath('/mnt/c/work/dir')).toBe('C:\\work\\dir')
    expect(mntToWindowsPath('/home/u')).toBeNull()
  })

  it('canonicalizes Windows paths case-insensitively', () => {
    expect(canonicalWindowsPath('C:\\Work\\Dir\\')).toBe('c:\\work\\dir')
    expect(canonicalWindowsPath('c:/work/dir')).toBe('c:\\work\\dir')
    expect(canonicalWindowsPath('/home/u')).toBeNull()
  })

  it('classifies path shapes', () => {
    expect(isAbsoluteLinuxPath('/home/u')).toBe(true)
    expect(isAbsoluteLinuxPath('C:\\work')).toBe(false)
    expect(isValidWslUsername('ramos')).toBe(true)
    expect(isValidWslUsername('-rf')).toBe(false)
    expect(isValidWslUsername('')).toBe(false)
  })
})

describe('credentials store', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-wsl-cred-'))
    process.env.DSH_HOME = home
  })
  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('stores and reads a workspace username, and clears it on undefined', () => {
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\u\\project'
    expect(getWorkspaceUsername(unc)).toBeUndefined()
    setWorkspaceUsername(unc, 'ramos')
    expect(getWorkspaceUsername(unc)).toBe('ramos')
    setWorkspaceUsername(unc, undefined)
    expect(getWorkspaceUsername(unc)).toBeUndefined()
    expect(() => { setWorkspaceUsername('C:\\work', 'x') }).toThrow('not a WSL UNC path')
  })

  it('registers a Windows-drive workspace and reads it back canonically', () => {
    registerWindowsWorkspace('D:\\Work\\Proj', 'Ubuntu', 'ramos')
    expect(getWindowsWorkspace('d:/work/proj')).toEqual({ distro: 'Ubuntu', username: 'ramos' })
    expect(getWindowsWorkspace('C:\\elsewhere')).toBeUndefined()
    expect(() => { registerWindowsWorkspace('/home/u', 'Ubuntu', undefined) }).toThrow('not a Windows drive path')
  })
})

/** A recording local subprocess provider. */
function recordingLocal(): { runtime: SubprocessRuntime; spawns: SubprocessSpawnSpec[]; terminals: SubprocessTerminalSpawnSpec[] } {
  const spawns: SubprocessSpawnSpec[] = []
  const terminals: SubprocessTerminalSpawnSpec[] = []
  const runtime = Object.create(null) as SubprocessRuntime
  runtime.spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    spawns.push(spec)
    return Object.create(null) as SubprocessHandle
  }
  runtime.spawnTerminal = (spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> => {
    terminals.push(spec)
    return Promise.resolve(Object.create(null) as SubprocessTerminalHandle)
  }
  return { runtime, spawns, terminals }
}

function backend(username?: string, probe?: (args: readonly string[]) => Promise<string | undefined>) {
  const local = recordingLocal()
  const ctx = new Context()
  const world = createWslWorldBackend(
    {
      ctx,
      localSubprocess: () => local.runtime,
      relayPath: 'C:\\relay\\relay.js',
      ...probe === undefined ? {} : { probe },
    },
    { distro: 'Ubuntu', ...username === undefined ? {} : { username } },
  )
  return { world, local }
}

describe('createWslWorldBackend', () => {
  it('claims UNC paths of its own distribution only', () => {
    const { world } = backend()
    expect(world.ref).toBe('wsl:Ubuntu')
    expect(world.displayName).toBe('Ubuntu (WSL)')
    expect(world.ownsPath('\\\\wsl.localhost\\Ubuntu\\home\\u')).toBe(true)
    expect(world.ownsPath('\\\\wsl$\\Ubuntu\\etc')).toBe(true)
    expect(world.ownsPath('\\\\wsl.localhost\\Debian\\home')).toBe(false)
    expect(world.ownsPath('C:\\work')).toBe(false)
    expect(world.ownsPath('/home/u')).toBe(false)
  })

  it('detects its distribution from a UNC cwd, with the stored user when present', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-cred-'))
    process.env.DSH_HOME = home
    try {
      const { world } = backend()
      expect(world.detectFromCwd('\\\\wsl.localhost\\Ubuntu\\home\\u')).toBe('wsl:Ubuntu')
      setWorkspaceUsername('\\\\wsl.localhost\\Ubuntu\\home\\u', 'ramos')
      expect(world.detectFromCwd('\\\\wsl.localhost\\Ubuntu\\home\\u')).toBe('wsl:Ubuntu:ramos')
      expect(world.detectFromCwd('\\\\wsl.localhost\\Debian\\home\\u')).toBeNull()
      expect(world.detectFromCwd('C:\\work')).toBeNull()
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('claims and detects credential-registered drive workspaces', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-cred-'))
    process.env.DSH_HOME = home
    try {
      registerWindowsWorkspace('D:\\Work\\Proj', 'Ubuntu', 'ramos')
      const { world } = backend()
      expect(world.ownsPath('d:\\work\\proj')).toBe(true)
      expect(world.detectFromCwd('D:\\Work\\Proj')).toBe('wsl:Ubuntu:ramos')
      expect(world.detectFromCwd('C:\\elsewhere')).toBeNull()
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('WslSubprocessRuntime', () => {
  function spawnSpec(cwd: string, argv: readonly string[] = ['pwd']): SubprocessSpawnSpec {
    return { argv, cwd, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100 }
  }

  it('wraps a one-shot spawn as wsl.exe --exec with the translated cwd', () => {
    const { world, local } = backend('ramos')
    world.subprocess.spawn(spawnSpec('\\\\wsl.localhost\\Ubuntu\\home\\u\\project', ['git', 'status']))
    expect(local.spawns).toHaveLength(1)
    const spec = local.spawns[0]!
    expect(spec.argv).toEqual(['wsl.exe', '-d', 'Ubuntu', '-u', 'ramos', '--cd', '/home/u/project', '--exec', 'git', 'status'])
    expect(spec.env?.WSLENV).toBeDefined()
  })

  it('translates a Linux cwd and a drive-letter cwd', () => {
    const { world, local } = backend()
    world.subprocess.spawn(spawnSpec('/home/u/project'))
    expect(local.spawns[0]!.argv).toEqual(['wsl.exe', '-d', 'Ubuntu', '--cd', '/home/u/project', '--exec', 'pwd'])
    world.subprocess.spawn(spawnSpec('D:\\Work\\Proj'))
    expect(local.spawns[1]!.argv).toEqual(['wsl.exe', '-d', 'Ubuntu', '--cd', '/mnt/d/Work/Proj', '--exec', 'pwd'])
    expect(local.spawns[1]!.cwd).toBe('D:\\Work\\Proj')
  })

  it('refuses a cwd of another distribution and a non-world cwd', () => {
    const { world } = backend()
    expect(() => world.subprocess.spawn(spawnSpec('\\\\wsl.localhost\\Debian\\home'))).toThrow('belongs to distribution "Debian"')
    expect(() => world.subprocess.spawn(spawnSpec('\\\\server\\share'))).toThrow('not in the WSL execution world')
  })

  it('falls back to the local world for host-packaged binaries, translating paths to UNC', () => {
    const { world, local } = backend()
    world.subprocess.spawn(spawnSpec(
      '\\\\wsl.localhost\\Ubuntu\\home\\u',
      ['C:\\harness\\node_modules\\rg\\rg.exe', '--no-config', '--json', '--regexp=foo', '--', '/home/u/project'],
    ))
    const spec = local.spawns[0]!
    expect(spec.argv).toEqual([
      'C:\\harness\\node_modules\\rg\\rg.exe', '--no-config', '--json', '--regexp=foo', '--',
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\project',
    ])
    expect(spec.cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u')
  })

  it('runs terminals through the relay behind the local PTY with the session coordinates in env', async () => {
    const { world, local } = backend('ramos')
    await world.subprocess.spawnTerminal({
      argv: ['ignored'],
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u\\project',
      rows: 24,
      cols: 80,
      terminalType: 'xterm-256color',
      graceMs: 100,
    })
    const spec = local.terminals[0]!
    expect(spec.argv).toEqual([process.execPath, 'C:\\relay\\relay.js'])
    expect(spec.cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u\\project')
    expect(spec.env).toMatchObject({ DSH_WSL_DISTRO: 'Ubuntu', DSH_WSL_USER: 'ramos' })
  })

  it('resolves executables through the in-distro probe and rejects cleanly', async () => {
    const { world } = backend(undefined, async args => (args[0] === 'which' && args[2] === 'git' ? '/usr/bin/git' : undefined))
    await expect(world.subprocess.resolveExecutable('git')).resolves.toBe('/usr/bin/git')
    await expect(world.subprocess.resolveExecutable('missing-cmd')).rejects.toThrow(SubprocessExecutableNotFoundError)
    await expect(world.subprocess.resolveExecutable('relative/bin')).rejects.toThrow(SubprocessExecutableNotFoundError)
    await expect(world.subprocess.terminalEnvironment()).resolves.toEqual({ platform: 'posix', defaultShell: '/bin/bash' })
  })
})

describe('resolveRelayPath', () => {
  it('finds the built relay script', () => {
    expect(resolveRelayPath()).toMatch(/relay\.js$/)
  })
})
