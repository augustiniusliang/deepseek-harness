/**
 * Host-workspace discovery for `@file` completion. The index contains paths
 * only: selected values remain ordinary prompt text and file contents stay
 * behind the model-facing `read` tool.
 *
 * A session's root set is its working directory (the main root) plus the extra
 * roots the `sandboxExtraRoots` session projection folds. Relative queries and
 * relative candidate paths stay anchored to the main root while an extra root
 * contributes absolute paths, so one display path always names one location.
 *
 * @module @deepseek-ai/dsh-file-reference-local/search
 */

import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'

export { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

/** Default maximum file and directory candidates rendered for one query. */
export const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20
/** Default maximum entries retained in one workspace search index. */
export const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 50_000
/**
 * Directory basenames omitted from traversal unless the deployment overrides
 * them: version-control and dependency stores plus build-output names that no
 * ecosystem also uses for sources. Generated files carry the basenames of the
 * sources that produced them, so an unfiltered tree both spends the entry
 * budget twice and ranks `dist/x.js` beside `src/x.ts` for every query.
 *
 * `lib` is deliberately absent: Ruby gems and many npm packages keep their
 * sources there, and excluding it would make `@` miss those sources entirely
 * and silently. A workspace that builds into `lib` adds it through
 * `excludedDirectories`.
 */
export const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
] as const

/** Resolved limits and exclusions for one workspace index. */
export interface FileSearchConfig {
  /** Maximum ranked candidates returned for one query. */
  maxResults: number
  /** Maximum indexed files and directories. */
  maxEntries: number
  /** Directory basenames never traversed or offered. */
  excludedDirectories: readonly string[]
}

interface IndexedPath extends FileReferenceCandidate {}

interface RankedPath {
  candidate: FileReferenceCandidate
  score: number
  /** Source root's position in the queried root order; candidates from one root keep their relative order. */
  root: number
}

interface IndexGeneration {
  controller: AbortController
  promise: Promise<IndexedPath[]>
}

/** A completed traversal and the invalidation counter it observed at its start. */
interface SettledIndex {
  entries: IndexedPath[]
  startedAt: number
}

/**
 * Cancellable, reusable fuzzy index rooted at one agent working directory.
 * Directory-scoped queries list live state; bare fuzzy queries share one
 * bounded traversal. Only the first query of a workspace waits for that
 * traversal — an invalidated index keeps answering while its replacement
 * builds behind the caret.
 */
export class WorkspaceFileSearch {
  private readonly excludedDirectories: ReadonlySet<string>
  private settled: SettledIndex | undefined
  private generation: IndexGeneration | undefined
  /** Monotonic invalidation counter; a settled index below it is stale. */
  private invalidations = 0
  private disposed = false

  constructor(
    private readonly root: string,
    private readonly config: FileSearchConfig,
  ) {
    if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
      throw new Error('file search maxResults must be a positive safe integer')
    }
    if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
      throw new Error('file search maxEntries must be a positive safe integer')
    }
    if (config.excludedDirectories.some(name => name.length === 0 || name.includes('/') || name.includes('\\'))) {
      throw new Error('file search excludedDirectories entries must be non-empty directory basenames')
    }
    this.excludedDirectories = new Set(config.excludedDirectories)
  }

  /**
   * Return ranked path candidates for the current token.
   * @param rawQuery - path text following `@` or `@"`.
   * @param signal - cancels this caller's wait without killing an index shared by a newer query.
   * @returns at most `maxResults` deterministic candidates.
   */
  async list(rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    if (this.disposed) return []
    const query = rawQuery.replaceAll('\\', '/')
    const slash = query.lastIndexOf('/')
    if (query === '' || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1)
      const fragment = slash < 0 ? '' : query.slice(slash + 1)
      return this.listDirectory(directory, fragment, signal)
    }
    const indexed = await this.indexFor(signal)
    return rankCandidates(
      indexed.filter(candidate => visibleForGlobalQuery(candidate.path, query)),
      query,
      this.config.maxResults,
    )
  }

  /**
   * Mark the index stale so a later bare query observes a fresh tree.
   *
   * The stale entries are kept and keep answering: a rebuild costs one
   * traversal of the whole workspace, and putting that in front of the caret
   * is what a caller invalidating on every tool result would otherwise pay.
   */
  invalidate(): void {
    this.invalidations += 1
  }

  /** Abort traversal and make later queries return no candidates. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation?.controller.abort(new Error('file search index disposed'))
    this.generation = undefined
    this.settled = undefined
  }

  /**
   * The entries a bare fuzzy query ranks. Only the first query of a workspace
   * waits for a traversal; afterwards a stale index answers immediately and
   * its replacement builds in the background.
   * @param signal - cancels this caller's wait without killing a shared traversal.
   * @returns indexed paths, at most one invalidation behind the tree.
   */
  private async indexFor(signal: AbortSignal): Promise<readonly IndexedPath[]> {
    const settled = this.settled
    if (settled === undefined) return waitForPromise(this.ensureIndex(), signal)
    if (settled.startedAt < this.invalidations) {
      void this.ensureIndex().catch(() => {
        // A background refresh failure is not this caller's error: the stale
        // entries still answer and `settled.startedAt` stays behind, so the
        // next bare query starts a fresh attempt.
      })
    }
    return settled.entries
  }

  private ensureIndex(): Promise<IndexedPath[]> {
    if (this.generation !== undefined) return this.generation.promise
    const controller = new AbortController()
    const startedAt = this.invalidations
    const generation = {
      controller,
      promise: Promise.resolve([] as IndexedPath[]),
    } satisfies IndexGeneration
    generation.promise = this.scanWorkspace(controller.signal).then(
      (entries) => {
        /* v8 ignore next -- disposal aborts this traversal, so it reaches the
         * rejection handler instead; the guard only covers a scan that finished
         * its last directory in the instant before the abort landed, and must
         * not hand a disposed index its entries back. */
        if (this.disposed) return entries
        this.generation = undefined
        this.settled = { entries, startedAt }
        return entries
      },
      (error: unknown) => {
        /* v8 ignore next -- dispose clears `generation` synchronously; this only protects an unexpected scan failure */
        if (this.generation === generation) this.generation = undefined
        throw error
      },
    )
    this.generation = generation
    return generation.promise
  }

  private async scanWorkspace(signal: AbortSignal): Promise<IndexedPath[]> {
    const indexed: IndexedPath[] = []
    const directories: { absolute: string; relative: string }[] = [{ absolute: this.root, relative: '' }]
    for (let cursor = 0; cursor < directories.length && indexed.length < this.config.maxEntries; cursor += 1) {
      signal.throwIfAborted()
      const directory = directories[cursor]
      /* v8 ignore next 3 -- cursor is bounded by this exact queue's length. */
      if (directory === undefined) {
        throw new Error('file search selected a missing directory')
      }
      // The root is not a subtree: an unreadable branch costs its own
      // candidates, but an unreadable root means the traversal learned
      // nothing. Letting that settle would publish an empty index over
      // entries that are still good and leave no invalidation to retry from.
      const entries = cursor === 0
        ? await readWorkspaceRoot(directory.absolute, signal)
        : await readDirectory(directory.absolute, signal)
      for (const entry of entries) {
        signal.throwIfAborted()
        const path = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`
        if (entry.isDirectory()) {
          if (this.excludedDirectories.has(entry.name)) continue
          indexed.push({ path, kind: 'directory' })
          directories.push({ absolute: join(directory.absolute, entry.name), relative: path })
        } else if (entry.isFile()) {
          indexed.push({ path, kind: 'file' })
        }
        if (indexed.length >= this.config.maxEntries) break
      }
    }
    return indexed
  }

  private async listDirectory(
    displayDirectory: string,
    fragment: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    if (displayDirectory.split('/').some(segment => this.excludedDirectories.has(segment))) return []
    const absolute = await resolveDisplayDirectory(this.root, displayDirectory, signal)
    if (absolute === undefined) return []
    const entries = await readDirectory(absolute, signal)
    const candidates: FileReferenceCandidate[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') && !fragment.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (this.excludedDirectories.has(entry.name)) continue
        candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'directory' })
      } else if (entry.isFile()) {
        candidates.push({ path: `${displayDirectory}${entry.name}`, kind: 'file' })
      }
    }
    return rankCandidates(candidates, fragment, this.config.maxResults)
  }
}

/** One root of a session's root set and the display rule its candidates follow. */
interface RootSearch {
  /** The root's own index. */
  search: WorkspaceFileSearch
  /** The root's path: the base of the absolute display paths it contributes. */
  root: string
  /** True when this root's candidates are displayed absolute (every extra root). */
  absolute: boolean
}

/**
 * File-reference search over one session's complete root set: the main root
 * (the session working directory) and the session's extra roots. Each root owns
 * one index, and a query merges every root's candidates into one ranking.
 *
 * The main root keeps the single-root behavior verbatim: relative queries and
 * relative display paths mean it. An extra root answers relative queries too —
 * the same path holds there — but its candidates and any absolute query inside
 * it are displayed absolute, so an extra root's path can never be mistaken for
 * a main-root one.
 */
export class WorkspaceRootsFileSearch {
  private readonly main: WorkspaceFileSearch
  private readonly extras = new Map<string, WorkspaceFileSearch>()
  private extraRoots: readonly string[]
  private disposed = false

  constructor(
    private readonly mainRoot: string,
    extraRoots: readonly string[],
    private readonly config: FileSearchConfig,
  ) {
    this.main = new WorkspaceFileSearch(mainRoot, config)
    this.extraRoots = dedupeRoots(extraRoots, mainRoot)
  }

  /**
   * Return ranked path candidates for the current token over every root.
   * @param rawQuery - path text following `@` or `@"`.
   * @param signal - cancels this caller's wait without killing an index shared by a newer query.
   * @returns at most `maxResults` deterministic candidates.
   */
  async list(rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    if (this.disposed) return []
    const query = rawQuery.replaceAll('\\', '/')
    const slash = query.lastIndexOf('/')
    // A query without a separator fuzzily matches indexed basenames; every
    // other query (including the empty one) lists one directory level.
    const directory = slash < 0 ? '' : query.slice(0, slash + 1)
    const fragment = slash < 0 ? query : query.slice(slash + 1)
    const groups: FileReferenceCandidate[][] = []
    for (const target of this.targetsFor(directory)) {
      groups.push(await this.candidatesOf(target, query, signal))
    }
    return rankMergedCandidates(groups, fragment, this.config.maxResults)
  }

  /**
   * Replace the extra roots of the set — a project change. The main root's
   * index is untouched, an added root indexes on its first query, and a removed
   * root is disposed and stops contributing.
   * @param extraRoots - the session's current extra roots, in logged order.
   */
  setExtraRoots(extraRoots: readonly string[]): void {
    this.extraRoots = dedupeRoots(extraRoots, this.mainRoot)
    for (const [root, search] of this.extras) {
      if (this.extraRoots.includes(root)) continue
      search.dispose()
      this.extras.delete(root)
    }
  }

  /**
   * Mark every root's index stale so a later query observes a fresh tree.
   * @see WorkspaceFileSearch.invalidate
   */
  invalidate(): void {
    this.main.invalidate()
    for (const search of this.extras.values()) search.invalidate()
  }

  /** Abort traversal and make later queries return no candidates. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.main.dispose()
    for (const search of this.extras.values()) search.dispose()
    this.extras.clear()
  }

  /**
   * The roots one query searches: an absolute directory addresses the one root
   * that contains it, and everything else — a relative directory, a bare fuzzy
   * token — searches the whole set. An extra root's index is created here, at
   * its first query, so an untouched root costs no traversal.
   */
  private targetsFor(directory: string): RootSearch[] {
    const targets: RootSearch[] = [{ search: this.main, root: this.mainRoot, absolute: false }]
    for (const root of this.extraRoots) {
      let search = this.extras.get(root)
      if (search === undefined) {
        search = new WorkspaceFileSearch(root, this.config)
        this.extras.set(root, search)
      }
      targets.push({ search, root, absolute: true })
    }
    if (!isAbsolute(directory)) return targets
    const owner = targets.find(target => containsRoot(target.root, directory))
    return owner === undefined ? [] : [owner]
  }

  /**
   * One root's candidates for a query, in display paths. An extra root that
   * cannot be read contributes none of its own: completion is advisory, so a
   * project folder that moved or vanished must not fail the whole query. The
   * main root's failure and any abort stay fatal.
   */
  private async candidatesOf(target: RootSearch, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    try {
      const found = await target.search.list(query, signal)
      return target.absolute
        ? found.map(candidate => ({ path: absoluteDisplayPath(target.root, candidate.path), kind: candidate.kind }))
        : found
    } catch (error: unknown) {
      // An abort is the caller's own cancellation, not an unreadable root.
      if (!target.absolute || signal.aborted) throw error
      return []
    }
  }
}

/** The extra roots in logged order without the main root and without duplicates. */
function dedupeRoots(roots: readonly string[], mainRoot: string): string[] {
  return [...new Set(roots.filter(root => root !== mainRoot))]
}

/** Whether a display path resolves inside `root`, following the same rules as {@link resolveDisplayDirectory}. */
function containsRoot(root: string, displayPath: string): boolean {
  const resolvedRoot = resolve(root)
  const fromRoot = relative(resolvedRoot, resolve(resolvedRoot, displayPath))
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

/**
 * The absolute display path of one candidate inside an extra root. The index
 * builds forward-slash paths on every platform, so the absolute form joins the
 * root in that same form; a candidate the root already reported absolute (an
 * absolute directory query inside it) passes through.
 */
function absoluteDisplayPath(root: string, path: string): string {
  if (isAbsolute(path)) return path
  return `${root.replaceAll('\\', '/').replace(/\/+$/u, '')}/${path}`
}

async function resolveDisplayDirectory(
  root: string,
  displayDirectory: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const resolvedRoot = resolve(root)
  const absolute = resolve(resolvedRoot, displayDirectory === '' ? '.' : displayDirectory)
  const fromRoot = relative(resolvedRoot, absolute)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return undefined
  /* v8 ignore next -- only Windows can produce a cross-volume absolute relative path */
  if (isAbsolute(fromRoot)) return undefined
  let current = resolvedRoot
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    signal.throwIfAborted()
    current = join(current, segment)
    try {
      const status = await lstat(current)
      signal.throwIfAborted()
      if (status.isSymbolicLink() || !status.isDirectory()) return undefined
    } catch (_error: unknown) {
      signal.throwIfAborted()
      return undefined
    }
  }
  return absolute
}

async function readWorkspaceRoot(absolute: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const entries = await readdir(absolute, { withFileTypes: true })
  signal.throwIfAborted()
  return entries.sort((left, right) => compareText(left.name, right.name))
}

async function readDirectory(absolute: string, signal: AbortSignal) {
  signal.throwIfAborted()
  try {
    const entries = await readdir(absolute, { withFileTypes: true })
    signal.throwIfAborted()
    return entries.sort((left, right) => compareText(left.name, right.name))
  } catch (_error: unknown) {
    /* v8 ignore start -- Windows chmod cannot make the unreadable-directory fixture fail readdir; POSIX behavior covers this fallback. */
    signal.throwIfAborted()
    // An unreadable/missing subtree contributes no candidates; other readable
    // branches remain useful and autocomplete is advisory.
    return []
    /* v8 ignore stop */
  }
}

function visibleForGlobalQuery(path: string, query: string): boolean {
  if (query.startsWith('.') || query.includes('/.')) return true
  return !path.split('/').some(segment => segment.startsWith('.'))
}

/**
 * Rank one root's candidates.
 * @param candidates - the candidates, in display paths.
 * @param query - the token they rank against ('' for a directory level).
 * @param limit - the result cap.
 * @returns at most `limit` candidates.
 */
function rankCandidates(
  candidates: readonly FileReferenceCandidate[],
  query: string,
  limit: number,
): FileReferenceCandidate[] {
  return rankMergedCandidates([candidates], query, limit)
}

/**
 * Rank candidates merged from several roots, in root order: when two candidates
 * score alike, an earlier group's comes first, so the main root's candidates
 * lead the list and a single-root query orders exactly as {@link rankCandidates}
 * alone would.
 * @param groups - one candidate list per root, in queried root order.
 * @param query - the token they rank against ('' for a directory level).
 * @param limit - the result cap.
 * @returns at most `limit` candidates.
 */
function rankMergedCandidates(
  groups: readonly (readonly FileReferenceCandidate[])[],
  query: string,
  limit: number,
): FileReferenceCandidate[] {
  const ranked: RankedPath[] = []
  groups.forEach((group, root) => {
    for (const candidate of group) {
      const score = scoreCandidate(candidate, query)
      if (score !== undefined) ranked.push({ candidate, score, root })
    }
  })
  ranked.sort((left, right) =>
    right.score - left.score
    || left.root - right.root
    || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
    || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
    || compareText(left.candidate.path, right.candidate.path))
  return ranked.slice(0, limit).map(entry => entry.candidate)
}

function scoreCandidate(candidate: FileReferenceCandidate, query: string): number | undefined {
  if (query === '') return 0
  const path = candidate.path.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const needle = query.toLowerCase()
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0
  if (name === needle) return 1_000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  if (path.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(path, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

function subsequenceScore(target: string, query: string): number | undefined {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

function kindRank(kind: FileReferenceCandidate['kind']): number {
  return kind === 'directory' ? 0 : 1
}

function compareText(left: string, right: string): number {
  /* v8 ignore next -- entries and candidates are unique; host enumeration
   * order determines which comparison direction sort requests. */
  return left < right ? -1 : left > right ? 1 : 0
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  /* v8 ignore next -- `list()` checks this signal immediately before its synchronous call into this helper */
  if (signal.aborted) return Promise.reject(errorReason(signal.reason, 'file search aborted'))
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => { rejectPromise(errorReason(signal.reason, 'file search aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(errorReason(error, 'file search index failed'))
      },
    )
  })
}

function errorReason(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason })
}
