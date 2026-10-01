/**
 * Project dialogs. `ProjectCreateDialog` names a project, its primary root,
 * and any extra roots; confirming registers the primary root as a Host
 * Workspace (idempotent for one already registered), creates the project, and
 * hands the Workspace id back for a Session. `ProjectFoldersDialog` edits the
 * extra roots of an existing project, whose primary root stays fixed.
 *
 * Both forms read and write root paths through the same fields and each drives
 * its hosting surface's directory-flow hole from "Browse…", so the picking
 * interaction stays whatever the deployment composed (native chooser or in-app
 * browser) and a surface without one still allows typing a path. A path the
 * hole fills is the path that field adopts; a failure from the interaction
 * itself lands in the dialog's alert.
 *
 * Each dialog is rendered only while it is open: mounting is the open gesture,
 * which seeds the form from the project it edits and leaves no draft behind.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DirectoryFlowOwnerProps, WorkspaceBrowserProps } from './contract/slots.ts'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  Button, IconPlusOutlineRegular, IconTrashOutlineRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Project, ProjectCreateInput, ProjectRoot, ProjectRoots, ProjectUpdateInput } from './projects.ts'
import css from './ProjectDialogs.module.css'

/** The `workspace` locale seat every project surface passes down. */
type ProjectTranslate = WorkspaceBrowserProps['t']

/** One root field a directory-flow pick fills. */
export type RootPickTarget = { kind: 'primary' } | { kind: 'extra'; index: number }

/** The extra-root field a folder-management form picks for (its primary root is fixed). */
export type ExtraPickTarget = Extract<RootPickTarget, { kind: 'extra' }>

/** Directory-picking conversation of one roots form. */
interface RootPicker<Target extends RootPickTarget> {
  /** Whether this surface composes a picking interaction at all. */
  available: boolean
  /** Whether a pick is open (the dialog is then not dismissable). */
  picking: boolean
  /** Failure the interaction itself reported, until the next pick or edit. */
  failure: string | null
  /** Raise the hole for one field. */
  request: (target: Target) => void
  /** Drop a reported interaction failure (an edit supersedes it). */
  clearFailure: () => void
  /** The hole's occurrence; only the surface that declares the hole may render it. */
  element: ReactNode
}

/**
 * Drive the hosting surface's directory-flow hole from one roots form: the
 * form raises the hole for a field, and the picked path (or the interaction's
 * own failure) lands back in that form.
 * @param useDirectoryFlow - bound occupancy selector hook for the surface's hole.
 * @param renderDirectoryFlow - the surface's hole render occurrence.
 * @param fill - adopt a picked path into the requesting field.
 * @returns the pick state, its controls, and the hole element.
 */
function useRootPicker<Target extends RootPickTarget>(
  useDirectoryFlow: SnapshotSelectorHook<boolean>,
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode,
  fill: (target: Target, path: string) => void,
): RootPicker<Target> {
  const available = useDirectoryFlow(occupied => occupied)
  const [target, setTarget] = useState<Target | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // The pick settles against the handlers of the render that opened it; the
  // fill callback rides a ref so a re-render mid-pick cannot retarget it.
  const latest = useRef(fill)
  latest.current = fill
  const owner: DirectoryFlowOwnerProps = {
    open: target !== null,
    // Picking fills a text field, so the owner never has an adoption in
    // flight whose commit affordances the occupant would have to disable.
    busy: false,
    onPicked: (path) => {
      const filled = target
      setTarget(null)
      /* v8 ignore next -- the occupant reports one pick per open request (its owner contract). */
      if (filled !== null) latest.current(filled, path)
    },
    onCancel: () => { setTarget(null) },
    onError: (message) => {
      setTarget(null)
      setFailure(message)
    },
  }
  return {
    available,
    picking: target !== null,
    failure,
    request: (next) => {
      setFailure(null)
      setTarget(next)
    },
    clearFailure: () => { setFailure(null) },
    element: renderDirectoryFlow(owner),
  }
}

/** One root row: the path input beside its browse and remove controls. */
function RootRow({ value, available, disabled, ariaLabel, onChange, onBrowse, onRemove, t }: {
  value: string
  available: boolean
  disabled: boolean
  ariaLabel: string
  onChange: (path: string) => void
  onBrowse: () => void
  /** Absent on the primary root of an existing project, which never changes. */
  onRemove?: (() => void) | undefined
  t: ProjectTranslate
}) {
  return (
    <div className={css.rootRow}>
      <input
        className={css.input}
        type="text"
        value={value}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value) }}
      />
      {available && (
        <Button variant="outline" disabled={disabled} onClick={onBrowse}>{t('project.browse')}</Button>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('project.removeRoot', { path: value })}
          disabled={disabled}
          onClick={onRemove}
        >
          <IconTrashOutlineRegular size={14} />
        </button>
      )}
    </div>
  )
}

/** The extra-root rows plus their add control, shared by both forms. */
function ExtraRoots({ roots, available, disabled, onPick, onChange, onAdd, onRemove, t }: {
  roots: readonly string[]
  available: boolean
  disabled: boolean
  onPick: (index: number) => void
  onChange: (index: number, path: string) => void
  onAdd: () => void
  onRemove: (index: number) => void
  t: ProjectTranslate
}) {
  return (
    <div className={css.field}>
      <span className={css.label}>{t('project.extraRoots')}</span>
      {roots.map((path, index) => (
        <RootRow
          // Rows are positional and only appended to or removed from the end,
          // so the index keeps each row's text with the field it edits.
          key={index}
          value={path}
          available={available}
          disabled={disabled}
          ariaLabel={t('project.extraRoot', { n: index + 1 })}
          onChange={(next) => { onChange(index, next) }}
          onBrowse={() => { onPick(index) }}
          onRemove={() => { onRemove(index) }}
          t={t}
        />
      ))}
      <button type="button" className={css.addRoot} disabled={disabled} onClick={onAdd}>
        <IconPlusOutlineRegular size={14} />
        {t('project.addRoot')}
      </button>
    </div>
  )
}

/** A failed write as the text its own failure carries (Host business messages pass through untranslated). */
function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** The non-blank extra roots a form submits, in field order. */
function submittedExtras(extras: readonly string[]): ProjectRoot[] {
  return extras.map(path => path.trim()).filter(path => path !== '').map(path => ({ path }))
}

/** Props of the create-project dialog (rendered while open). */
export interface ProjectCreateDialogProps {
  /** Dismiss (mask, Escape, Close); a creation in flight or an open pick keeps the dialog up. */
  onClose: () => void
  /** Adopt the primary root as a Host Workspace (an already registered path answers that Workspace). */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** Create the project once its primary root exists as a Host Workspace. */
  createProject: (input: ProjectCreateInput) => Promise<Project>
  /** Read the project overlay again; a failed read keeps the last answer. */
  refreshProjects: () => Promise<void>
  /** The project exists and its Workspace is adopted: target a Session there. */
  onCreated: (workspaceId: WorkspaceId) => void
  /** Bound occupancy selector hook for this surface's directory-flow hole. */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation. */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  t: ProjectTranslate
}

/**
 * Render the create-project dialog.
 * @param props - the Workspace and project writes, the overlay refresh, and the surface's picking share.
 * @returns the dialog element.
 */
export function ProjectCreateDialog({
  onClose, createWorkspace, createProject, refreshProjects, onCreated,
  useDirectoryFlow, renderDirectoryFlow, t,
}: ProjectCreateDialogProps) {
  const [name, setName] = useState('')
  const [primary, setPrimary] = useState('')
  const [extras, setExtras] = useState<readonly string[]>([])
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => { void refreshProjects() }, [refreshProjects])
  const picker = useRootPicker(useDirectoryFlow, renderDirectoryFlow, (field, path) => {
    if (field.kind === 'primary') setPrimary(path)
    else setExtras(next => next.map((value, index) => index === field.index ? path : value))
  })
  // A creation and an open pick each own the dialog until they settle: neither
  // may be dismissed out from under, and the confirm waits for the other.
  const busy = creating || picker.picking
  const blocked = busy || primary.trim() === ''
  // Any edit supersedes both failure surfaces the form can show.
  const clearFailures = (): void => {
    setFailure(null)
    picker.clearFailure()
  }

  const confirm = (): void => {
    /* v8 ignore next -- the dialog's confirm is disabled while a creation is in flight and until a primary root is typed. */
    if (blocked) return
    setCreating(true)
    setFailure(null)
    const path = primary.trim()
    const roots: ProjectRoots = [{ path }, ...submittedExtras(extras)]
    createWorkspace({ path })
      .then(workspace => createProject({ name: name.trim(), roots }).then(() => workspace.workspaceId))
      .then((workspaceId) => {
        setCreating(false)
        onCreated(workspaceId)
      })
      .catch((reason: unknown) => {
        setCreating(false)
        setFailure(failureText(reason))
      })
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      closeLabel={t('close')}
      title={t('project.create.title')}
      description={t('project.create.desc')}
      footer={(
        <>
          <Button variant="outline" disabled={busy} className={css.modalAction} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={blocked} className={css.modalAction} onClick={confirm}>
            {t('project.create.submit')}
          </Button>
        </>
      )}
    >
      <div className={css.field}>
        <span className={css.label}>{t('project.name')}</span>
        <input
          className={css.input}
          type="text"
          value={name}
          placeholder={t('project.namePlaceholder')}
          aria-label={t('project.name')}
          data-modal-autofocus
          disabled={busy}
          onChange={(event) => { setName(event.target.value); clearFailures() }}
        />
      </div>
      <div className={css.field}>
        <span className={css.label}>{t('project.primaryRoot')}</span>
        <RootRow
          value={primary}
          available={picker.available}
          disabled={busy}
          ariaLabel={t('project.primaryRoot')}
          onChange={(path) => { setPrimary(path); clearFailures() }}
          onBrowse={() => { picker.request({ kind: 'primary' }) }}
          t={t}
        />
        <span className={css.hint}>{t('project.primaryRootHint')}</span>
      </div>
      <ExtraRoots
        roots={extras}
        available={picker.available}
        disabled={busy}
        onPick={(index) => { picker.request({ kind: 'extra', index }) }}
        onChange={(index, path) => {
          setExtras(next => next.map((value, at) => at === index ? path : value))
          clearFailures()
        }}
        onAdd={() => { setExtras(next => [...next, '']) }}
        onRemove={(index) => { setExtras(next => next.filter((_, at) => at !== index)) }}
        t={t}
      />
      {picker.failure !== null && <div className={css.failure} role="alert">{picker.failure}</div>}
      {failure !== null && <div className={css.failure} role="alert">{failure}</div>}
      {picker.element}
    </Modal>
  )
}

/** Props of the manage-folders dialog (rendered while open). */
export interface ProjectFoldersDialogProps {
  /** Project under edit; its roots seed the form and its primary root stays fixed. */
  project: Project
  /** Dismiss (mask, Escape, Close); an update in flight or an open pick keeps the dialog up. */
  onClose: () => void
  /** Patch the project's roots; the primary root is submitted unchanged. */
  updateProject: (input: ProjectUpdateInput) => Promise<Project>
  /** Bound occupancy selector hook for this surface's directory-flow hole. */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation. */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  t: ProjectTranslate
}

/**
 * Render the manage-folders dialog: an existing project's primary root reads
 * as static text, and its extra roots are editable.
 * @param props - the project under edit, the roots write, and the surface's picking share.
 * @returns the dialog element.
 */
export function ProjectFoldersDialog({
  project, onClose, updateProject, useDirectoryFlow, renderDirectoryFlow, t,
}: ProjectFoldersDialogProps) {
  const [extras, setExtras] = useState<readonly string[]>(() => project.roots.slice(1).map(root => root.path))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const picker = useRootPicker<ExtraPickTarget>(useDirectoryFlow, renderDirectoryFlow, (field, path) => {
    setExtras(next => next.map((value, index) => index === field.index ? path : value))
  })
  const busy = saving || picker.picking
  const primary = project.roots[0].path
  // Any edit supersedes both failure surfaces the form can show.
  const clearFailures = (): void => {
    setFailure(null)
    picker.clearFailure()
  }

  const confirm = (): void => {
    /* v8 ignore next -- the dialog's save is disabled while a save or a pick is in flight. */
    if (busy) return
    setSaving(true)
    setFailure(null)
    const roots: ProjectRoots = [{ path: primary }, ...submittedExtras(extras)]
    updateProject({ id: project.id, roots })
      .then(() => {
        setSaving(false)
        onClose()
      })
      .catch((reason: unknown) => {
        setSaving(false)
        setFailure(failureText(reason))
      })
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      closeLabel={t('close')}
      title={t('project.folders.title', { name: project.name })}
      description={t('project.folders.desc')}
      footer={(
        <>
          <Button variant="outline" disabled={busy} className={css.modalAction} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={busy} className={css.modalAction} onClick={confirm}>
            {t('project.folders.submit')}
          </Button>
        </>
      )}
    >
      <div className={css.field}>
        <span className={css.label}>{t('project.primaryRoot')}</span>
        <div className={css.rootRow}>
          <span className={css.staticPath} title={primary}>{primary}</span>
        </div>
      </div>
      {/* jscpd:ignore-start -- create/manage dialogs intentionally share the extra-roots form block */}
      <ExtraRoots
        roots={extras}
        available={picker.available}
        disabled={busy}
        onPick={(index) => { picker.request({ kind: 'extra', index }) }}
        onChange={(index, path) => {
          setExtras(next => next.map((value, at) => at === index ? path : value))
          clearFailures()
        }}
        onAdd={() => { setExtras(next => [...next, '']) }}
        onRemove={(index) => { setExtras(next => next.filter((_, at) => at !== index)) }}
        t={t}
      />
      {picker.failure !== null && <div className={css.failure} role="alert">{picker.failure}</div>}
      {failure !== null && <div className={css.failure} role="alert">{failure}</div>}
      {picker.element}
      {/* jscpd:ignore-end */}
    </Modal>
  )
}
