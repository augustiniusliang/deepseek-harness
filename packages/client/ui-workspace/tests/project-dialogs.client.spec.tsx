// @vitest-environment jsdom
/**
 * Project dialogs: one form creates a project (Workspace first, then the
 * project, then the Session target) and one manages an existing project's
 * folders. Both drive the hosting surface's directory-flow hole from their
 * Browse controls, so these cases probe the hole exactly as a composed
 * occupant would answer it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DirectoryFlowOwnerProps } from '../src/client/contract/slots.ts'
import type { Project, ProjectCreateInput, ProjectRoots, ProjectUpdateInput } from '../src/client/projects.ts'
import { ProjectCreateDialog, ProjectFoldersDialog } from '../src/client/ProjectDialogs.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const wid = (id: string) => id as WorkspaceId
const roots = (path: string, ...extras: string[]): ProjectRoots => [{ path }, ...extras.map(extra => ({ path: extra }))]
const project = (id: string, name: string, rootList: ProjectRoots): Project =>
  ({ id, name, roots: rootList, createdAt: 0 })

/** Occupancy source bound like the renderer binds it; flip() drives the hook. */
function occupancy(initial = true) {
  let occupied = initial
  const listeners = new Set<() => void>()
  const useDirectoryFlow = bindSnapshotSelector({
    getSnapshot: () => occupied,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  return {
    useDirectoryFlow,
    flip: (next: boolean) => {
      occupied = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Probe occupant of the directory-flow hole: records the owner conversation and renders a marker while open. */
function flowProbe() {
  const probe: { owner: DirectoryFlowOwnerProps | undefined } = { owner: undefined }
  const renderDirectoryFlow = (owner: DirectoryFlowOwnerProps) => {
    probe.owner = owner
    return owner.open ? <div data-testid="directory-flow" /> : null
  }
  return { probe, renderDirectoryFlow }
}

function mountCreate(overrides: {
  createWorkspace?: (input: { path: string }) => Promise<WorkspaceView>
  createProject?: (input: ProjectCreateInput) => Promise<Project>
  refreshProjects?: () => Promise<void>
  onCreated?: (workspaceId: WorkspaceId) => void
  onClose?: () => void
  occupancy?: ReturnType<typeof occupancy>
} = {}) {
  const created = { ...project('p1', 'Alpha', roots('/w/alpha')), workspaceId: wid('w1') }
  const createWorkspace = vi.fn(overrides.createWorkspace ?? (async (): Promise<WorkspaceView> => ({
    workspaceId: wid('w1'), path: '/w/alpha', title: 'alpha', sessionIds: [], createdAt: '0', updatedAt: '0',
  })))
  const createProject = vi.fn(overrides.createProject ?? (async () => created))
  const onCreated = overrides.onCreated ?? vi.fn()
  const onClose = overrides.onClose ?? vi.fn()
  const refreshProjects = overrides.refreshProjects ?? vi.fn(async () => {})
  const occupancySource = overrides.occupancy ?? occupancy()
  const { probe, renderDirectoryFlow } = flowProbe()
  const view = render(
    <ProjectCreateDialog
      t={t}
      onClose={onClose}
      createWorkspace={createWorkspace}
      createProject={createProject}
      refreshProjects={refreshProjects}
      onCreated={onCreated}
      useDirectoryFlow={occupancySource.useDirectoryFlow}
      renderDirectoryFlow={renderDirectoryFlow}
    />,
  )
  return { view, probe, createWorkspace, createProject, onCreated, onClose, refreshProjects, occupancy: occupancySource }
}

function mountFolders(overrides: {
  project?: Project
  updateProject?: (input: ProjectUpdateInput) => Promise<Project>
  onClose?: () => void
  occupancy?: ReturnType<typeof occupancy>
} = {}) {
  const target = overrides.project ?? project('p1', 'Alpha', roots('/w/alpha', '/w/data'))
  const updateProject = vi.fn(overrides.updateProject ?? (async () => target))
  const onClose = overrides.onClose ?? vi.fn()
  const occupancySource = overrides.occupancy ?? occupancy()
  const { probe, renderDirectoryFlow } = flowProbe()
  const view = render(
    <ProjectFoldersDialog
      t={t}
      project={target}
      onClose={onClose}
      updateProject={updateProject}
      useDirectoryFlow={occupancySource.useDirectoryFlow}
      renderDirectoryFlow={renderDirectoryFlow}
    />,
  )
  return { view, probe, updateProject, onClose, occupancy: occupancySource }
}

describe('ProjectCreateDialog', () => {
  it('creates the Workspace, then the project, then targets the Session there', async () => {
    const createWorkspace = vi.fn(async () => ({ workspaceId: wid('w9') } as WorkspaceView))
    const createProject = vi.fn(async (input: ProjectCreateInput) => project('p9', input.name, input.roots))
    const onCreated = vi.fn()
    const b = mountCreate({ createWorkspace, createProject, onCreated })
    b.createWorkspace.mockClear()

    // Nothing to submit before a primary root exists.
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '创建项目' })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '  Gamma  ' } })
    fireEvent.change(screen.getByLabelText('主根'), { target: { value: '  /w/gamma  ' } })
    expect(submit.disabled).toBe(false)
    expect(b.refreshProjects).toHaveBeenCalledTimes(1)

    await act(async () => { fireEvent.click(submit) })
    expect(b.createWorkspace).toHaveBeenCalledWith({ path: '/w/gamma' })
    expect(b.createProject).toHaveBeenCalledWith({ name: 'Gamma', roots: roots('/w/gamma') })
    expect(b.onCreated).toHaveBeenCalledWith(wid('w9'))
    // The Workspace is adopted before the project is created.
    expect(b.createWorkspace.mock.invocationCallOrder[0]!)
      .toBeLessThan(b.createProject.mock.invocationCallOrder[0]!)
  })

  it('submits the primary root first and drops blank extra roots', async () => {
    const b = mountCreate()
    b.createWorkspace.mockClear()
    fireEvent.change(screen.getByLabelText('主根'), { target: { value: '/w/alpha' } })
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    const [first, second] = screen.getAllByLabelText<HTMLInputElement>(/^额外根/)
    fireEvent.change(first!, { target: { value: '/w/data' } })
    fireEvent.change(second!, { target: { value: '   ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建项目' })) })
    expect(b.createProject).toHaveBeenCalledWith({
      name: '',
      roots: [{ path: '/w/alpha' }, { path: '/w/data' }],
    })
  })

  it('fills the field that raised the pick, and reports an interaction failure in its own alert', () => {
    const b = mountCreate()
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '浏览…' }))
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    act(() => { b.probe.owner!.onPicked('/picked/primary') })
    expect(screen.getByLabelText<HTMLInputElement>('主根').value).toBe('/picked/primary')
    expect(screen.queryByTestId('directory-flow')).toBeNull()

    // A second field's pick fills that row, not the primary root; a third row
    // stays blank.
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    fireEvent.click(screen.getAllByRole('button', { name: '浏览…' })[1]!)
    act(() => { b.probe.owner!.onPicked('/picked/extra') })
    expect(screen.getByLabelText<HTMLInputElement>('额外根 1').value).toBe('/picked/extra')
    expect(screen.getByLabelText<HTMLInputElement>('额外根 2').value).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>('主根').value).toBe('/picked/primary')

    // Cancelling and a hole-reported failure both withdraw the pick.
    fireEvent.click(screen.getAllByRole('button', { name: '浏览…' })[1]!)
    act(() => { b.probe.owner!.onCancel() })
    expect(screen.queryByTestId('directory-flow')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: '浏览…' })[1]!)
    act(() => { b.probe.owner!.onError('no chooser installed') })
    expect(screen.getByRole('alert').textContent).toBe('no chooser installed')
    fireEvent.change(screen.getByLabelText('额外根 1'), { target: { value: '/typed' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('hides the browse control without a composed picking interaction', () => {
    mountCreate({ occupancy: occupancy(false) })
    expect(screen.queryByRole('button', { name: '浏览…' })).toBeNull()
    expect(screen.getByLabelText('主根')).toBeTruthy()
  })

  it('keeps the dialog up through a creation and reports its failure', async () => {
    let reject!: (reason: unknown) => void
    const pending = new Promise<WorkspaceView>((_, fail) => { reject = fail })
    const createWorkspace = vi.fn()
      .mockImplementationOnce(() => pending)
      .mockRejectedValueOnce('denied')
    const onClose = vi.fn()
    mountCreate({ createWorkspace, onClose })
    fireEvent.change(screen.getByLabelText('主根'), { target: { value: '/w/alpha' } })
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }))
    expect(screen.getByLabelText<HTMLInputElement>('项目名称').disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
    // Escape and the close control cannot dismiss a creation in flight.
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { reject(new Error('path is not a directory')) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('path is not a directory') })
    expect(screen.getByLabelText<HTMLInputElement>('项目名称').disabled).toBe(false)

    // A non-Error rejection reports its text.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建项目' })) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })

    // An open pick owns the dialog too: neither dismissal path closes it.
    fireEvent.click(screen.getByRole('button', { name: '浏览…' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('removes extra rows and closes on request', () => {
    const onClose = vi.fn()
    mountCreate({ onClose })
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    fireEvent.change(screen.getByLabelText('额外根 1'), { target: { value: '/w/extra' } })
    fireEvent.click(screen.getByRole('button', { name: '移除「/w/extra」' }))
    expect(screen.queryByLabelText('额外根 1')).toBeNull()
    // Both dismissal paths reach the owner while no interaction owns the dialog.
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('ProjectFoldersDialog', () => {
  it('keeps the primary root fixed and saves the edited extra roots', async () => {
    const target = project('p1', 'Alpha', roots('/w/alpha', '/w/data'))
    const updateProject = vi.fn(async () => target)
    const onClose = vi.fn()
    const b = mountFolders({ project: target, updateProject, onClose })
    expect(screen.getByRole('dialog').textContent).toContain('/w/alpha')
    const saved = screen.getByLabelText<HTMLInputElement>('额外根 1')
    expect(saved.value).toBe('/w/data')
    fireEvent.change(saved, { target: { value: '/w/data2' } })
    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    fireEvent.change(screen.getByLabelText('额外根 2'), { target: { value: '/w/new' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(b.updateProject).toHaveBeenCalledWith({
      id: 'p1',
      roots: [{ path: '/w/alpha' }, { path: '/w/data2' }, { path: '/w/new' }],
    })
    await waitFor(() => { expect(onClose).toHaveBeenCalled() })
  })

  it('fills an extra row from the hole and keeps a failed save open', async () => {
    const updateProject = vi.fn<(input: ProjectUpdateInput) => Promise<Project>>()
      .mockRejectedValueOnce(new Error('项目不存在'))
      .mockRejectedValueOnce('denied')
    const onClose = vi.fn()
    const b = mountFolders({
      project: project('p1', 'Alpha', roots('/w/alpha', '/w/data', '/w/logs')),
      updateProject,
      onClose,
    })
    fireEvent.click(screen.getAllByRole('button', { name: '浏览…' })[1]!)
    act(() => { b.probe.owner!.onPicked('/picked/logs') })
    expect(screen.getByLabelText<HTMLInputElement>('额外根 1').value).toBe('/w/data')
    expect(screen.getByLabelText<HTMLInputElement>('额外根 2').value).toBe('/picked/logs')

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('项目不存在') })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('reports an interaction failure and clears it on the next edit', () => {
    const onClose = vi.fn()
    const b = mountFolders({ onClose })
    fireEvent.click(screen.getAllByRole('button', { name: '浏览…' })[0]!)
    act(() => { b.probe.owner!.onError('no chooser installed') })
    expect(screen.getByRole('alert').textContent).toBe('no chooser installed')
    fireEvent.change(screen.getByLabelText('额外根 1'), { target: { value: '/typed' } })
    expect(screen.queryByRole('alert')).toBeNull()
    // Dismissal reaches the owner while no interaction owns the dialog.
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('removes an extra row and holds the dialog while one is being picked', () => {
    const onClose = vi.fn()
    const b = mountFolders({ onClose })
    fireEvent.click(screen.getAllByRole('button', { name: '移除「/w/data」' })[0]!)
    expect(screen.queryByLabelText('额外根 1')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }))
    fireEvent.click(screen.getByRole('button', { name: '浏览…' }))
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(b.probe.owner!.open).toBe(true)
  })

  it('ranks a pick that targets no extra row as nothing to fill', () => {
    const b = mountFolders()
    // The primary root is fixed, so a primary-targeted pick is a no-op: the
    // form only ever raises extra-root picks.
    fireEvent.click(screen.getByRole('button', { name: '浏览…' }))
    act(() => { b.probe.owner!.onPicked('/picked/data') })
    expect(screen.getByLabelText<HTMLInputElement>('额外根 1').value).toBe('/picked/data')
  })
})
