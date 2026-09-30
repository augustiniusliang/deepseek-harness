/**
 * The tree's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `setRoots` / `refresh` /
 * `toggle`, and this face performs the listing and writes the outcome through
 * the store's own actions — the Slot-standard `inject` shape, so the session id
 * is resolved by the framework and the write set stays the store's.
 *
 * The listing itself is bound here to the Client Remote face: the tree keys
 * every level by absolute path and hands the endpoint that same absolute path;
 * the endpoint answers with the directory's path relative to its own root as
 * well, which the tree has no use for and drops. The tree holds one open node
 * per root of the session, so a root the session logs while the tab is open
 * starts listing under it too.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten,
 * so no later settlement writes to it.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirLevel, createFilesStore } from './store.ts'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryNode } from './directory-node.ts'

/**
 * Observe one directory without recursively watching its descendants.
 * @param sessionId - Session owning the directory tree.
 * @param path - absolute directory path.
 * @param signal - node lifetime.
 * @returns readiness and invalidation notifications.
 */
export type WatchWorkspaceDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>

/**
 * Bind directory observation to the Remote stream supervisor.
 * @param remote - Client Remote with workspace file streams.
 * @returns a watcher that awaits stream disposal when its node ends.
 */
export function createWatch(remote: ClientRemote): WatchWorkspaceDirectory {
  return async function* (sessionId, path, signal) {
    const aborted = (): boolean => signal.aborted
    if (aborted()) return
    const stream = remote.$stream<WorkspaceFileWatchFrame>({
      name: `directory ${path}`,
      open: lifetime => remote.workspaceFiles.changes(sessionId, path, lifetime),
      ended: () => new Error(`Directory watch ended: ${path}`),
    })
    const abort = (): void => { void stream.dispose() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const item of stream) {
        if (aborted()) return
        if (item.value.kind === 'ready') item.accept()
        yield item.value.kind
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await stream.dispose()
    }
  }
}

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's `list`, exactly as the Host's generated client declares it.
 */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/**
 * Bind the listing to one Remote face, keeping only what the tree stores.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing the tree's face performs.
 */
export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }
}

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/**
 * Every root one Session's file tree shows, primary first.
 *
 * The Session's working directory leads, because a relative path and a
 * `session`-scoped file address still resolve against it; the extra roots it
 * logged follow, minus a repeat of the primary and of one another — the folded
 * list may name a directory twice, and two nodes for one directory would be
 * one directory too many.
 * @param cwd - the Session's working directory, as the Session list reports it.
 * @param extraRoots - the session's `sandboxExtraRoots` projection value; null and undefined both mean none.
 * @returns the roots to show, never empty.
 */
export function sessionRoots(cwd: string, extraRoots: readonly string[] | null | undefined): [string, ...string[]] {
  return [cwd, ...new Set((extraRoots ?? []).filter(root => root !== cwd))]
}

/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /** Refresh the open directory tree. @param tabId - owning tab. */
  readonly refresh: (tabId: TabId) => void
  /** Control automatic rereads without closing watches. @param tabId - owning tab. @param enabled - automatic-refresh setting. */
  readonly setAutoRefresh: (tabId: TabId, enabled: boolean) => void
  /**
   * Seed this tab's tree and list every root.
   * @param tabId - the tab being drawn.
   * @param roots - absolute paths of the roots, primary first.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, roots: readonly [string, ...string[]], signal: AbortSignal) => void
  /**
   * Follow the Session's current roots, opening the added ones and closing the
   * dropped ones. A tab that has not started yet is left to `start`.
   * @param tabId - the tab being drawn.
   * @param roots - absolute paths of the roots, primary first.
   * @param signal - the tab record's lifetime.
   */
  readonly setRoots: (tabId: TabId, roots: readonly [string, ...string[]], signal: AbortSignal) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, retaining intent during ancestor restoration.
   * @param tabId - the tab being drawn.
   * @param parentPath - the listed parent directory's exact tree key.
   * @param path - absolute directory path.
   * @param expanded - current expansion preferences, including descendants to restore.
   * @param signal - the tab record's lifetime.
   */
  readonly toggle: (tabId: TabId, parentPath: string, path: string, expanded: readonly string[], signal: AbortSignal) => void
}

/**
 * Bind the tree's face to one directory listing.
 * @param list - the bound `workspaceFiles.list` call.
 * @param watch - target-scoped directory observation.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(
  list: ListWorkspaceDirectory,
  watch: WatchWorkspaceDirectory,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesInjected {
  return (
    sessionId: SessionId,
    actions: BoundActions<ReturnType<typeof createFilesStore>>,
  ): FilesInjected => {
    /** Per tab, per absolute path: the listing generation a settlement must match; the latest request wins. */
    const generations = new Map<TabId, Map<string, number>>()
    const trees = new Map<TabId, readonly DirectoryNode[]>()
    const closeAll = (nodes: readonly DirectoryNode[] | undefined): Promise<void> =>
      Promise.all((nodes ?? []).map(node => node.close())).then(() => undefined)
    const nodeFor = (tabId: TabId, path: string, signal: AbortSignal): DirectoryNode => new DirectoryNode(path,
      (child, lifetime) => load(tabId, child, lifetime),
      (child, lifetime) => watch(sessionId, child, lifetime),
      (child, error) => {
        if (!signal.aborted) actions.failed(tabId, child, new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}))
      }, signal,
    ).open()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const load = async (tabId: TabId, path: string, signal: AbortSignal): Promise<DirLevel | undefined> => {
      if (signal.aborted) return
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      return list(sessionId, path, signal).then((result) => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (signal.aborted || generations.get(tabId)?.get(path) !== generation) return
        if (result.ok) actions.loaded(tabId, path, result.value)
        else actions.failed(tabId, path, result.error)
        return result.ok ? result.value : undefined
      })
    }
    return {
      refresh: (tabId) => { void Promise.all((trees.get(tabId) ?? []).map(node => node.refreshTree())) },
      setAutoRefresh: (tabId, enabled) => {
        actions.autoRefresh(tabId, enabled)
        for (const node of trees.get(tabId) ?? []) node.setAutomatic(enabled)
      },
      start(tabId, roots, signal) {
        actions.start(tabId, roots)
        signal.addEventListener('abort', () => {
          void closeAll(trees.get(tabId))
          trees.delete(tabId)
          generations.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
        trees.set(tabId, roots.map(root => nodeFor(tabId, root, signal)))
      },
      setRoots(tabId, roots, signal) {
        if (signal.aborted) return
        const current = trees.get(tabId)
        if (current === undefined) return
        actions.setRoots(tabId, roots)
        const open = new Map(current.map(node => [node.path, node]))
        const next = roots.map(root => open.get(root) ?? nodeFor(tabId, root, signal))
        // A dropped root leaves the tree entirely: its watch ends and its
        // subtree's reads are abandoned, as a collapsed directory's are.
        for (const node of current) if (!roots.includes(node.path)) void node.close()
        trees.set(tabId, next)
      },
      load: (tabId, path, signal) => { void load(tabId, path, signal) },
      toggle(tabId, parentPath, path, expanded, signal) {
        if (signal.aborted) return
        const tree = trees.get(tabId)
        if (tree === undefined) return
        // A root row toggles visibility alone: the root node IS the tree's top
        // level, so there is no parent to open or close that path through.
        if (tree.some(node => node.path === path)) {
          actions.toggled(tabId, path)
          return
        }
        const parent = tree.map(node => node.find(parentPath)).find(found => found !== undefined)
        if (parent === undefined && !expanded.includes(parentPath)) return
        const collapsing = expanded.includes(path)
        const next = collapsing ? expanded.filter(value => value !== path) : [...expanded, path]
        for (const node of tree) node.setExpanded(next)
        if (collapsing) void parent?.collapse(path)
        else parent?.expand(path, next)
        actions.toggled(tabId, path)
      },
    }
  }
}
