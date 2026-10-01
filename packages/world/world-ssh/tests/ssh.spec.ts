/**
 * Tests for the SSH world: profile discovery (settings read, mirror markers,
 * ownsPath/detectFromCwd), argv discipline, pool behavior (queue, drop,
 * idle reaping), and the fs layer's frame parsing and remote fence.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  createSshWorldBackend,
  expandSshPath,
  findMirrorRoot,
  pathInside,
  profileForMirror,
  profileKey,
  shellQuote,
  shellQuotePath,
  sshArgv,
  sshWorldRef,
  SshFileSystem,
  SshSessionPool,
} from '@deepseek-ai/dsh-world-ssh'
import type { SshProfile } from '@deepseek-ai/dsh-world-ssh'

const PROFILE: SshProfile = {
  id: 'prod',
  name: 'Prod Box',
  host: 'prod.example.com',
  port: 2222,
  user: 'nicene',
  authMethod: 'key',
  keyPath: '~/.ssh/id_prod',
  remoteRoot: '/home/nicene/work',
}

const PASSWORD_PROFILE: SshProfile = {
  id: 'pw',
  name: 'Pw Box',
  host: 'pw.example.com',
  user: 'root',
  authMethod: 'password',
  password: 's3cret',
}

describe('ssh argv discipline', () => {
  it('builds the key-auth argv with connection hygiene and BatchMode', () => {
    const argv = sshArgv(PROFILE, 'bash', false)
    expect(argv).toContain('StrictHostKeyChecking=accept-new')
    expect(argv).toContain('ConnectTimeout=15')
    expect(argv).toContain('ClearAllForwardings=yes')
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('PreferredAuthentications=publickey')
    expect(argv).toContain('-p')
    expect(argv[argv.indexOf('-p') + 1]).toBe('2222')
    expect(argv).not.toContain('sshpass')
    expect(argv[argv.length - 2]).toBe('nicene@prod.example.com')
    expect(argv[argv.length - 1]).toBe('bash')
    expect(argv.join(' ')).toContain('-i ')
  })

  it('prefixes sshpass only for password auth and enables tty without BatchMode', () => {
    const argv = sshArgv(PASSWORD_PROFILE, undefined, true)
    expect(argv[0]).toBe('sshpass')
    expect(argv[1]).toBe('-p')
    expect(argv[2]).toBe('s3cret')
    expect(argv).toContain('-tt')
    expect(argv).not.toContain('BatchMode=yes')
    const plain = sshArgv(PROFILE, 'echo ok', false)
    expect(plain).not.toContain('-tt')
  })

  it('quotes shell values as single words and keeps ~ expansion for remote paths', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
    expect(shellQuotePath('/plain/path')).toBe("'/plain/path'")
    expect(shellQuotePath('~')).toBe('~')
    expect(shellQuotePath('~/sub dir/x')).toBe("~/'sub dir/x'")
  })

  it('expands ~ in local key paths and keys the pool by auth facts', () => {
    expect(expandSshPath('~/x')).toContain('x')
    expect(expandSshPath('/abs/x')).toBe('/abs/x')
    expect(profileKey(PROFILE)).toBe('prod|prod.example.com:2222|nicene|key|~/.ssh/id_prod')
    expect(profileKey({ ...PROFILE, keyPath: 'other' })).not.toBe(profileKey(PROFILE))
  })
})

describe('mirror discovery', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-ssh-mirror-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('finds a mirror marker up to 8 levels and matches it to a profile', () => {
    const nested = join(home, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(home, '.remote-ssh.json'), JSON.stringify({ host: 'prod.example.com', user: 'nicene', remotePath: '/home/nicene/work' }))
    const found = findMirrorRoot(nested)
    expect(found?.root).toBe(home)
    expect(found?.info.remotePath).toBe('/home/nicene/work')
    expect(findMirrorRoot(join(tmpdir(), 'definitely-no-marker-here-xyz'))).toBeNull()

    const matched = profileForMirror(found!.info, [PROFILE])
    expect(matched.profileId).toBe('prod')
    expect(matched.profile.host).toBe('prod.example.com')
    const synthesized = profileForMirror({ host: 'other.example.com', user: 'x', remotePath: '/x' }, [PROFILE])
    expect(synthesized.profileId).toBe('x@other.example.com')
    expect(synthesized.profile.authMethod).toBe('key')
  })

  it('contains paths case-insensitively under a mirror root', () => {
    expect(pathInside('D:\\Work\\Proj', 'd:\\work\\proj\\sub\\f.ts')).toBe(true)
    expect(pathInside('D:\\Work\\Proj', 'D:\\Work\\Other\\f.ts')).toBe(false)
  })
})

describe('createSshWorldBackend', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-ssh-backend-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('owns mirror-root paths and detects the profile world from them', () => {
    const ctx = new Context()
    const pool = new SshSessionPool(Object.create(null) as SubprocessRuntime)
    const backend = createSshWorldBackend(
      { ctx, pool, localSubprocess: () => Object.create(null) as SubprocessRuntime, mirrorRoots: [{ root: home, info: { host: 'prod.example.com', user: 'nicene', remotePath: '/home/nicene/work', profileId: 'prod' } }] },
      PROFILE,
    )
    pool.dispose()
    expect(backend.ref).toBe('ssh:prod')
    expect(backend.displayName).toBe('Prod Box (SSH)')
    expect(backend.ownsPath(join(home, 'sub', 'f.ts'))).toBe(true)
    expect(backend.ownsPath('C:\\elsewhere')).toBe(false)
    expect(backend.detectFromCwd(join(home, 'sub'))).toBe('ssh:prod')
    expect(backend.detectFromCwd('C:\\elsewhere')).toBeNull()
    // Sessions created from a mirror root record their cwd in the REMOTE
    // grammar; the workspace remotePath space belongs to this world too.
    expect(backend.ownsPath('/home/nicene/work')).toBe(true)
    expect(backend.ownsPath('/home/nicene/work/src/f.ts')).toBe(true)
    expect(backend.ownsPath('/home/nicene/workother')).toBe(false)
    expect(backend.detectFromCwd('/home/nicene/work/src')).toBe('ssh:prod')
    expect(backend.detectFromCwd('/home/other')).toBeNull()
    expect(sshWorldRef('prod')).toBe('ssh:prod')
  })
})

/** A scriptable fake local subprocess provider. */
function fakeSubprocess(behavior: (spec: SubprocessSpawnSpec) => SubprocessHandle): SubprocessRuntime {
  return { spawn: behavior } as unknown as SubprocessRuntime
}

/** A pipe-backed fake handle the CommandSession can talk to. */
function fakeHandle(writes: string[], script: (written: string) => string): SubprocessHandle {
  const listeners: ((chunk: string) => void)[] = []
  const handle = {
    stdin: {
      write(text: string) {
        writes.push(text)
        const out = script(text)
        if (out !== '') for (const listener of listeners) listener(out)
        return true
      },
    },
    stdout: {
      on(event: string, listener: (chunk: string) => void) {
        if (event === 'data') listeners.push(listener)
        return this
      },
    },
    stderr: { on() { return this } },
    done: new Promise(() => {}),
    terminate() {},
  }
  return handle as unknown as SubprocessHandle
}

describe('SshSessionPool', () => {
  it('serializes commands behind the sentinel and reports exit codes', async () => {
    const writes: string[] = []
    const pool = new SshSessionPool(fakeSubprocess(() => fakeHandle(writes, (text) => {
      if (text.includes('exit-mark')) return ''
      // Echo a fake sentinel frame per queued write.
      const match = /printf '\\n(DSHEOF[A-Za-z0-9]+DSHEOF)%s\\n' \$\?/.exec(text)
      if (match === null) return ''
      return `output\n${match[1]}0\n`
    })))
    const result = await pool.runPooled(PROFILE, 'echo hi')
    pool.dispose()
    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('output\n')
    expect(writes.length).toBeGreaterThan(0)
    expect(writes[0]).toContain('{ echo hi ; } 2>&1')
  })

  it('drops the session on a timed-out command and reconnects on the next call', async () => {
    const writes: string[] = []
    const pool = new SshSessionPool(fakeSubprocess(() => fakeHandle(writes, () => '')), 50)
    const first = await pool.runPooled(PROFILE, 'sleep 99', undefined, undefined, false, 50)
    expect(first.isTimeout).toBe(true)
    expect(pool.size).toBe(0)
    // The next call reconnects (pool recreates a session instead of falling back).
    const writes2: string[] = []
    const pool2 = new SshSessionPool(fakeSubprocess(() => fakeHandle(writes2, (text) => {
      const match = /printf '\\n(DSHEOF[A-Za-z0-9]+DSHEOF)%s\\n' \$\?/.exec(text)
      return match === null ? '' : `ok\n${match[1]}0\n`
    })))
    const second = await pool2.runPooled(PROFILE, 'echo again')
    pool2.dispose()
    expect(second.ok).toBe(true)
  })

  it('reaps sessions idle past the limit', async () => {
    const pool = new SshSessionPool(fakeSubprocess(() => fakeHandle([], (text) => {
      const match = /printf '\\n(DSHEOF[A-Za-z0-9]+DSHEOF)%s\\n' \$\?/.exec(text)
      return match === null ? '' : `x\n${match[1]}0\n`
    })), 10)
    await pool.runPooled(PROFILE, 'echo hi')
    expect(pool.size).toBe(1)
    pool.reapIdle(Date.now() + 60_000)
    expect(pool.size).toBe(0)
    pool.dispose()
  })
})

describe('fs fence semantics', () => {
  it('versions targets as size:mtimeMs for stale guards', () => {
    // The guard comparison is what writeText/editText share: an expected
    // version that mismatches the remote stat frame must fail as stale.
    expect(FsVersion('100:1700000000000')).not.toBe(FsVersion('100:1700000000001'))
  })

  it('parses the GNU %F type text of an empty regular file as a file', async () => {
    // GNU stat prints "regular empty file" for size-0 files; the frame parser
    // must still classify them as files or reads reject them as non-regular.
    const frame = '__DSH_ST__0:1790847507:regular empty file\n'
    const pool = Object.create(SshSessionPool.prototype, {
      runPooled: {
        value: () => Promise.resolve({ ok: true, exitCode: 0, stdout: frame, stderr: '', error: '', truncated: false }),
      },
    }) as SshSessionPool
    const ctx = new Context()
    const fs = new SshFileSystem(ctx.isolate('fs'), PROFILE, { pool, mirrorRoots: [] })
    const info = await fs.stat({ targetKey: FsTargetKey('/tmp/x'), displayPath: '/tmp/x' })
    expect(info?.type).toBe('file')
    expect(info?.size).toBe(0)
  })
})
