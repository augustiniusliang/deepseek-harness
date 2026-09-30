/**
 * Project overlay store: the same-origin endpoint's answer is the only thing
 * the browser groups by, so these cases pin the decode, the silent absence of
 * an unserved endpoint, and the patch-then-reconcile of every write.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRoots } from '../src/client/projects.ts'
import { createProjectOverlayStore, PROJECTS_ROUTE } from '../src/client/projects.ts'

afterEach(() => { vi.unstubAllGlobals() })

interface Call { url: string; method: string; body: unknown }

/** Stub global fetch with one handler per request; every call is recorded. */
function stubFetch(handler: (call: Call) => {
  ok?: boolean
  status?: number
  payload?: unknown
  /** Simulate a 4xx/5xx body that cannot be read as JSON. */
  unreadable?: boolean
  reject?: unknown
}): Call[] {
  const calls: Call[] = []
  const fetchStub = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(init.body) as unknown,
    }
    calls.push(call)
    const answer = handler(call)
    if (answer.reject !== undefined) throw answer.reject
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: answer.unreadable === true
        ? async () => { throw new Error('invalid json') }
        : async () => answer.payload,
    }
  })
  vi.stubGlobal('fetch', fetchStub)
  return calls
}

const roots = (path: string, ...extras: string[]): ProjectRoots => [{ path }, ...extras.map(extra => ({ path: extra }))]
const served = (projects: readonly unknown[], attachments: unknown = {}) =>
  ({ projects, attachments })

describe('createProjectOverlayStore', () => {
  it('reads the endpoint once and publishes the decoded overlay', async () => {
    const calls = stubFetch(() => ({
      payload: served([
        { id: 'p1', name: 'Alpha', roots: [{ path: '/w/alpha', name: 'alpha' }, { path: '/w/data' }], createdAt: 7 },
        { id: 'p2', name: 'Beta', roots: roots('/w/beta') },
      ], { s1: 'p2', s2: 42, s3: '' }),
    }))
    const store = createProjectOverlayStore()
    expect(store.source.getSnapshot()).toBeUndefined()
    await store.refresh()
    expect(calls).toEqual([{ url: PROJECTS_ROUTE, method: 'GET', body: undefined }])
    expect(store.source.getSnapshot()).toEqual({
      projects: [
        { id: 'p1', name: 'Alpha', roots: [{ path: '/w/alpha', name: 'alpha' }, { path: '/w/data' }], createdAt: 7 },
        { id: 'p2', name: 'Beta', roots: roots('/w/beta'), createdAt: 0 },
      ],
      attachments: { s1: 'p2' },
    })
    store.dispose()
  })

  it('drops malformed projects and roots, and treats a non-overlay payload as no service', async () => {
    let payload: unknown = served([
      { id: '', name: 'no id', roots: roots('/w/x') },
      { id: 'no-name', roots: roots('/w/x') },
      { id: 'no-roots', name: 'Empty', roots: [] },
      { id: 'bad-roots', name: 'Bad', roots: 'nope' },
      { id: 'blank-root', name: 'Blank', roots: [{ path: '' }, { path: '/w/kept' }] },
      { id: 'kept', name: 'Kept', roots: roots('/w/kept') },
      'not an object',
    ], ['not', 'an object'])
    const calls = stubFetch(() => ({ payload }))
    const store = createProjectOverlayStore()
    await store.refresh()
    expect(store.source.getSnapshot()).toEqual({
      projects: [{ id: 'blank-root', name: 'Blank', roots: roots('/w/kept'), createdAt: 0 }, { id: 'kept', name: 'Kept', roots: roots('/w/kept'), createdAt: 0 }],
      attachments: {},
    })
    // A payload that is not an overlay at all leaves the last answer standing.
    const published = store.source.getSnapshot()
    payload = { unexpected: true }
    await store.refresh()
    expect(store.source.getSnapshot()).toBe(published)
    payload = 'not an object'
    await store.refresh()
    expect(store.source.getSnapshot()).toBe(published)
    expect(calls).toHaveLength(3)
    store.dispose()
  })

  it('keeps the last answer when the endpoint is absent or a read fails', async () => {
    let answer: { ok?: boolean; status?: number; payload?: unknown; reject?: unknown } = {
      payload: served([{ id: 'p1', name: 'Alpha', roots: roots('/w/alpha') }]),
    }
    stubFetch(() => answer)
    const store = createProjectOverlayStore()
    await store.refresh()
    const published = store.source.getSnapshot()
    expect(published?.projects).toHaveLength(1)
    answer = { ok: false, status: 404 }
    await store.refresh()
    expect(store.source.getSnapshot()).toBe(published)
    answer = { reject: new TypeError('Failed to parse URL') }
    await store.refresh()
    expect(store.source.getSnapshot()).toBe(published)
    store.dispose()
  })

  it('creates through the endpoint and publishes the answered project before reconciling', async () => {
    let listed: unknown[] = []
    const calls = stubFetch((call) => {
      if (call.method === 'POST') {
        const project = { id: 'p-new', name: 'Gamma', roots: roots('/w/gamma'), createdAt: 3 }
        listed = [project]
        return { payload: { ok: true, project } }
      }
      return { payload: served(listed) }
    })
    const store = createProjectOverlayStore()
    await store.refresh()
    const created = await store.create({ name: 'Gamma', roots: roots('/w/gamma') })
    expect(created.id).toBe('p-new')
    expect(calls[1]).toEqual({
      url: PROJECTS_ROUTE,
      method: 'POST',
      body: { action: 'create', name: 'Gamma', roots: roots('/w/gamma') },
    })
    expect(store.source.getSnapshot()?.projects.map(entry => entry.id)).toEqual(['p-new'])
    store.dispose()
  })

  it('creates with an absent overlay left absent, and patches updates in place', async () => {
    const calls = stubFetch((call) => {
      if (call.method === 'POST') {
        return { payload: { ok: true, project: { id: 'p1', name: 'Renamed', roots: roots('/w/alpha', '/w/extra') } } }
      }
      return { ok: false, status: 404 }
    })
    const store = createProjectOverlayStore()
    // No endpoint ever answered: the writes still reach it, but there is no
    // published overlay to patch and the overlay stays absent.
    await store.create({ name: 'Alpha', roots: roots('/w/alpha') })
    await store.update({ id: 'p1', name: 'Renamed' })
    await store.remove('p1')
    expect(store.source.getSnapshot()).toBeUndefined()
    expect(calls).toHaveLength(6)

    vi.unstubAllGlobals()
    let listed: unknown[] = [
      { id: 'p1', name: 'Alpha', roots: roots('/w/alpha') },
      { id: 'p2', name: 'Beta', roots: roots('/w/beta') },
    ]
    stubFetch((call) => {
      if (call.method === 'POST') {
        listed = [
          { id: 'p1', name: 'Renamed', roots: roots('/w/alpha', '/w/extra') },
          { id: 'p2', name: 'Beta', roots: roots('/w/beta') },
        ]
        return { payload: { ok: true, project: listed[0] } }
      }
      return { payload: served(listed) }
    })
    const servedStore = createProjectOverlayStore()
    await servedStore.refresh()
    await servedStore.update({ id: 'p1', name: 'Renamed', roots: roots('/w/alpha', '/w/extra') })
    expect(servedStore.source.getSnapshot()?.projects).toEqual([
      { id: 'p1', name: 'Renamed', roots: roots('/w/alpha', '/w/extra'), createdAt: 0 },
      { id: 'p2', name: 'Beta', roots: roots('/w/beta'), createdAt: 0 },
    ])
    servedStore.dispose()
    store.dispose()
  })

  it('removes the project and its attachments, and reports the endpoint failure message', async () => {
    let payload: unknown = served([
      { id: 'p1', name: 'Alpha', roots: roots('/w/alpha') },
      { id: 'p2', name: 'Beta', roots: roots('/w/beta') },
    ], { s1: 'p1', s2: 'p2' })
    let failure: { ok?: boolean; status?: number; payload?: unknown; unreadable?: boolean } = {}
    stubFetch((call) => {
      if (call.method === 'POST') return { ...failure, ok: failure.ok ?? true, status: failure.status ?? 200 }
      return { payload }
    })
    const store = createProjectOverlayStore()
    await store.refresh()
    payload = served([{ id: 'p2', name: 'Beta', roots: roots('/w/beta') }], { s2: 'p2' })
    await store.remove('p1')
    expect(store.source.getSnapshot()).toEqual({
      projects: [{ id: 'p2', name: 'Beta', roots: roots('/w/beta'), createdAt: 0 }],
      attachments: { s2: 'p2' },
    })

    // A business failure carries the endpoint's own message, untranslated.
    failure = { ok: false, status: 400, payload: { error: '项目不存在' } }
    await expect(store.remove('p1')).rejects.toThrow('项目不存在')
    // A failure without a message falls back to the status, including when the
    // body cannot be read at all.
    failure = { ok: false, status: 500, payload: undefined }
    await expect(store.remove('p1')).rejects.toThrow('project request failed: 500')
    failure = { ok: false, status: 502, unreadable: true }
    await expect(store.remove('p1')).rejects.toThrow('project request failed: 502')
    // An answer without a project cannot be adopted.
    failure = { payload: { ok: true } }
    await expect(store.create({ name: 'Gamma', roots: roots('/w/gamma') })).rejects.toThrow('project request answered without a project')
    failure = { payload: null }
    await expect(store.create({ name: 'Gamma', roots: roots('/w/gamma') })).rejects.toThrow('project request answered without a project')
    store.dispose()
  })

  it('abandons a read that settles after disposal', async () => {
    let settle!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const pending = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => { settle = resolve })
    vi.stubGlobal('fetch', vi.fn(() => pending))
    const store = createProjectOverlayStore()
    const refresh = store.refresh()
    store.dispose()
    settle({ ok: true, status: 200, json: async () => served([{ id: 'p1', name: 'Alpha', roots: roots('/w/alpha') }]) })
    await refresh
    expect(store.source.getSnapshot()).toBeUndefined()
  })
})
