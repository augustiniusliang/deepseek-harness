/**
 * Project overlay store: reads the same-origin project endpoint served by a
 * composed project plugin and publishes one overlay — every project plus the
 * explicit Session attachments — that the browser derives group presentation
 * from. A deployment without that plugin answers nothing, and the published
 * overlay stays absent so every surface keeps its plain Workspace form.
 *
 * A successful write patches the published overlay from the endpoint's own
 * answer, then reconciles with a read, so a created or renamed project shows
 * without waiting for a second round trip and another writer's changes land
 * with the read.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Same-origin route serving the project overlay. */
export const PROJECTS_ROUTE = '/api/ettore-project/projects'

/** One project root; the primary root is the project's Workspace directory. */
export interface ProjectRoot {
  /** Absolute directory path. */
  path: string
  /** Display name; absent means the path's final segment. */
  name?: string
}

/** A project's roots in order: the primary root first, then the writable extras. */
export type ProjectRoots = readonly [ProjectRoot, ...ProjectRoot[]]

/** One project: ordered roots with the primary root first. */
export interface Project {
  id: string
  name: string
  roots: ProjectRoots
  /** Creation time (epoch ms). */
  createdAt: number
}

/** Published overlay: the projects plus explicit Session-to-project bindings. */
export interface ProjectOverlay {
  projects: readonly Project[]
  /** Session id → project id. */
  attachments: Readonly<Record<string, string>>
}

/** Creation input: the primary root must already be a Host Workspace. */
export interface ProjectCreateInput {
  name: string
  roots: ProjectRoots
}

/** Patch input; an absent field keeps its current value. */
export interface ProjectUpdateInput {
  id: string
  name?: string
  /** The complete roots to write; the primary root stays first. */
  roots?: ProjectRoots
}

/** The browser's read and write face over the project overlay. */
export interface ProjectOverlayStore {
  /** Published overlay; absent until the endpoint has answered once. */
  readonly source: ObservableSnapshot<ProjectOverlay | undefined>
  /** Read the endpoint again; a failed read keeps the last answer standing. */
  refresh(): Promise<void>
  /** Create a project after its primary root exists as a Workspace. */
  create(input: ProjectCreateInput): Promise<Project>
  /** Patch a project's name and roots. */
  update(input: ProjectUpdateInput): Promise<Project>
  /** Delete the project grouping; folders, Sessions, and logs stay. */
  remove(id: string): Promise<void>
  /** Abandon in-flight reads and writes. */
  dispose(): void
}

/** Whether a decoded wire value is a JSON object (arrays are not). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decoded roots; entries without a usable path are dropped. */
function decodeRoots(value: unknown): ProjectRoot[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || entry.path === '') return []
    return [{ path: entry.path, ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}) }]
  })
}

/** One decoded project, or undefined when the value is not a project with a primary root. */
function decodeProject(value: unknown): Project | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '' || typeof value.name !== 'string') return undefined
  const [primary, ...extras] = decodeRoots(value.roots)
  if (primary === undefined) return undefined
  return {
    id: value.id,
    name: value.name,
    roots: [primary, ...extras],
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
  }
}

/** One decoded overlay, or undefined when the payload is not an overlay. */
function decodeOverlay(value: unknown): ProjectOverlay | undefined {
  if (!isRecord(value) || !Array.isArray(value.projects)) return undefined
  const attachments: Record<string, string> = {}
  if (isRecord(value.attachments)) {
    for (const [sessionId, projectId] of Object.entries(value.attachments)) {
      if (typeof projectId === 'string' && projectId !== '') attachments[sessionId] = projectId
    }
  }
  return { projects: value.projects.flatMap(entry => decodeProject(entry) ?? []), attachments }
}

/** The endpoint's own failure message, or undefined when the payload carries none. */
function failureText(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.error !== 'string' || value.error === '') return undefined
  return value.error
}

/**
 * Create the project overlay store.
 * @returns the store handle.
 */
export function createProjectOverlayStore(): ProjectOverlayStore {
  const overlay = createSnapshotStore<ProjectOverlay | undefined>(undefined)
  const lifetime = new AbortController()

  /** Read the endpoint; an absent or unreachable service answers undefined. */
  const read = async (): Promise<ProjectOverlay | undefined> => {
    try {
      const response = await fetch(PROJECTS_ROUTE, { signal: lifetime.signal })
      if (!response.ok) return undefined
      return decodeOverlay(await response.json())
    } catch {
      // Endpoint absent or unreachable: the overlay stays absent, and every
      // surface falls back to its plain Workspace presentation.
      return undefined
    }
  }

  const refresh = async (): Promise<void> => {
    const next = await read()
    if (next !== undefined && !lifetime.signal.aborted) overlay.set(next)
  }

  /** Write one action and return its payload; the endpoint reports business failures in the body. */
  const write = async (body: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(PROJECTS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: lifetime.signal,
    })
    const payload: unknown = await response.json().catch(() => undefined)
    const failure = failureText(payload)
    if (failure !== undefined) throw new Error(failure)
    if (!response.ok) throw new Error(`project request failed: ${response.status}`)
    return payload
  }

  const projectOf = (payload: unknown): Project => {
    const project = isRecord(payload) ? decodeProject(payload.project) : undefined
    if (project === undefined) throw new Error('project request answered without a project')
    return project
  }

  /** Replace one project in place; the attachments are another writer's. */
  const replaceProject = (project: Project): void => {
    const state = overlay.getSnapshot()
    if (state === undefined) return
    overlay.set({
      projects: state.projects.map(candidate => candidate.id === project.id ? project : candidate),
      attachments: state.attachments,
    })
  }

  return {
    source: overlay,
    refresh,
    async create(input): Promise<Project> {
      const project = projectOf(await write({ action: 'create', name: input.name, roots: input.roots }))
      const state = overlay.getSnapshot()
      if (state !== undefined) {
        overlay.set({ projects: [...state.projects, project], attachments: state.attachments })
      }
      await refresh()
      return project
    },
    async update(input): Promise<Project> {
      const project = projectOf(await write({
        action: 'update', id: input.id, name: input.name, roots: input.roots,
      }))
      replaceProject(project)
      await refresh()
      return project
    },
    async remove(id): Promise<void> {
      await write({ action: 'delete', id })
      const state = overlay.getSnapshot()
      if (state !== undefined) {
        overlay.set({
          projects: state.projects.filter(project => project.id !== id),
          attachments: Object.fromEntries(
            Object.entries(state.attachments).filter(([, projectId]) => projectId !== id),
          ),
        })
      }
      await refresh()
    },
    dispose(): void {
      lifetime.abort()
    },
  }
}
