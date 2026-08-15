import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getRunMock, saveMock } = vi.hoisted(() => ({
  getRunMock: vi.fn(),
  saveMock: vi.fn(),
}))

vi.mock('../../api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/workflows')>()
  return {
    ...actual,
    workflowsApi: {
      ...actual.workflowsApi,
      getRun: getRunMock,
      save: saveMock,
    },
  }
})

import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkflowStore } from '../../stores/workflowStore'
import { WorkflowSavePanel } from './WorkflowSavePanel'

const SESSION_ID = 'workflow-save-session'
const RUN_ID = 'wf_save1234-abc'
const SCRIPT = [
  "export const meta = { name: 'generated-audit', description: 'Audit routes' }",
  "return await agent('scan routes')",
].join('\n')

function completeWorkflowThroughRuntimeEvents({
  taskId = 'workflow-task-save',
  runId = RUN_ID,
  workflowName = 'generated-audit',
}: {
  taskId?: string
  runId?: string
  workflowName?: string
} = {}) {
  const store = useWorkflowStore.getState()
  store.handleTaskEvent(SESSION_ID, 'task_started', {
    task_id: taskId,
    task_type: 'local_workflow',
    workflow_name: workflowName,
    workflow_run_id: runId,
    description: 'Audit routes',
  })
  store.handleTaskEvent(SESSION_ID, 'task_progress', {
    task_id: taskId,
    workflow_run_id: runId,
    workflow_progress: [
      { type: 'workflow_phase', index: 1, title: 'Scan' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'scan routes',
        state: 'done',
        phaseIndex: 1,
        phaseTitle: 'Scan',
        agentId: 'agent-save-1',
      },
    ],
  })
  store.handleTaskEvent(SESSION_ID, 'task_notification', {
    task_id: taskId,
    workflow_run_id: runId,
    status: 'completed',
    summary: 'Dynamic workflow completed',
  })
}

describe('WorkflowSavePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useWorkflowStore.setState({ runs: {}, openRunId: null })
    getRunMock.mockResolvedValue({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workflowName: 'generated-audit',
      scriptPath: '/tmp/generated-audit.js',
      startedAt: 1,
      completedAgents: 1,
      script: SCRIPT,
      agents: [],
    })
    saveMock.mockResolvedValue({
      ok: true,
      name: 'release-audit',
      filePath: '/repo/.claude/workflows/release-audit.js',
    })
  })

  it('shows explicit help when this session has no completed workflow', () => {
    render(
      <WorkflowSavePanel
        sessionId={SESSION_ID}
        cwd="/repo"
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('Save workflow')).toBeInTheDocument()
    expect(screen.getByText(/Complete a workflow in this session/)).toBeInTheDocument()
    expect(getRunMock).not.toHaveBeenCalled()
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('saves a real completed run under the chosen /name', async () => {
    completeWorkflowThroughRuntimeEvents()

    render(
      <WorkflowSavePanel
        sessionId={SESSION_ID}
        cwd="/repo"
        onClose={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(getRunMock).toHaveBeenCalledWith(SESSION_ID, RUN_ID)
    })
    const name = await screen.findByRole('textbox', { name: 'Command name' })
    expect(name).toHaveValue('generated-audit')

    fireEvent.change(name, { target: { value: 'release-audit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        SCRIPT,
        'project',
        '/repo',
        'release-audit',
      )
    })
    expect(await screen.findByText(/Saved as \/release-audit/)).toBeInTheDocument()
  })

  it.each(['save-workflow', 'help', 'status', 'config', 'model'])(
    'rejects desktop-reserved /%s without calling save',
    async reservedName => {
      completeWorkflowThroughRuntimeEvents()
      render(
        <WorkflowSavePanel
          sessionId={SESSION_ID}
          cwd="/repo"
          onClose={vi.fn()}
        />,
      )

      const name = await screen.findByRole('textbox', { name: 'Command name' })
      fireEvent.change(name, { target: { value: reservedName } })

      expect(screen.getByText(`/${reservedName} is reserved by the desktop. Choose another name.`)).toBeInTheDocument()
      const save = screen.getByRole('button', { name: 'Save workflow' })
      expect(save).toBeDisabled()
      fireEvent.click(save)
      expect(saveMock).not.toHaveBeenCalled()
    },
  )

  it('rejects a command name already available in the session', async () => {
    completeWorkflowThroughRuntimeEvents()
    render(
      <WorkflowSavePanel
        sessionId={SESSION_ID}
        cwd="/repo"
        commands={[{ name: 'release-audit', description: 'Existing audit command' }]}
        onClose={vi.fn()}
      />,
    )

    const name = await screen.findByRole('textbox', { name: 'Command name' })
    fireEvent.change(name, { target: { value: 'Release-Audit' } })

    expect(screen.getByText('/Release-Audit is already an available command. Choose another name.')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save workflow' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('does not overwrite a name saved earlier in the same panel', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    completeWorkflowThroughRuntimeEvents({
      taskId: 'workflow-task-first',
      runId: 'wf_first123-abc',
      workflowName: 'first-audit',
    })
    now.mockReturnValue(2_000)
    completeWorkflowThroughRuntimeEvents({
      taskId: 'workflow-task-second',
      runId: 'wf_second12-abc',
      workflowName: 'second-audit',
    })
    now.mockRestore()
    getRunMock.mockImplementation((_sessionId: string, runId: string) =>
      Promise.resolve({
        runId,
        sessionId: SESSION_ID,
        workflowName:
          runId === 'wf_second12-abc' ? 'second-audit' : 'first-audit',
        scriptPath: `/tmp/${runId}.js`,
        startedAt: 1,
        completedAgents: 1,
        script: SCRIPT,
        agents: [],
      }),
    )
    render(
      <WorkflowSavePanel
        sessionId={SESSION_ID}
        cwd="/repo"
        onClose={vi.fn()}
      />,
    )

    const name = await screen.findByRole('textbox', { name: 'Command name' })
    fireEvent.change(name, { target: { value: 'release-audit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    expect(await screen.findByText(/Saved as \/release-audit/)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Completed run' }), {
      target: { value: 'workflow-task-first' },
    })
    await waitFor(() => {
      expect(getRunMock).toHaveBeenCalledWith(SESSION_ID, 'wf_first123-abc')
    })
    const nextName = await screen.findByRole('textbox', { name: 'Command name' })
    fireEvent.change(nextName, { target: { value: 'release-audit' } })

    expect(screen.getByText('/release-audit is already an available command. Choose another name.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save workflow' })).toBeDisabled()
    expect(saveMock).toHaveBeenCalledTimes(1)
  })

  it('locks run and form selection while a save is pending', async () => {
    completeWorkflowThroughRuntimeEvents()
    let resolveSave: (value: {
      ok: boolean
      name: string
      filePath: string
    }) => void = () => {}
    saveMock.mockImplementation(
      () => new Promise(resolve => {
        resolveSave = resolve
      }),
    )
    render(
      <WorkflowSavePanel
        sessionId={SESSION_ID}
        cwd="/repo"
        onClose={vi.fn()}
      />,
    )

    const name = await screen.findByRole('textbox', { name: 'Command name' })
    fireEvent.change(name, { target: { value: 'release-audit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))

    expect(screen.getByRole('combobox', { name: 'Completed run' })).toBeDisabled()
    expect(name).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Save scope' })).toBeDisabled()

    await act(async () => {
      resolveSave({
        ok: true,
        name: 'release-audit',
        filePath: '/repo/.claude/workflows/release-audit.js',
      })
    })
    expect(await screen.findByText(/Saved as \/release-audit/)).toBeInTheDocument()
  })

  it('retries a failed run detail load without closing the panel', async () => {
    completeWorkflowThroughRuntimeEvents()
    getRunMock.mockRejectedValueOnce(new Error('artifact is not ready'))
    render(
      <WorkflowSavePanel
        sessionId={SESSION_ID}
        cwd="/repo"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText(/artifact is not ready/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Completed run' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(getRunMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('textbox', { name: 'Command name' })).toHaveValue('generated-audit')
  })

  it('can switch to another completed run after the newest detail fails', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000)
    completeWorkflowThroughRuntimeEvents({
      taskId: 'workflow-task-older',
      runId: 'wf_older123-abc',
      workflowName: 'older-audit',
    })
    now.mockReturnValue(2_000)
    completeWorkflowThroughRuntimeEvents({
      taskId: 'workflow-task-newer',
      runId: 'wf_newer123-abc',
      workflowName: 'newer-audit',
    })
    now.mockRestore()
    getRunMock.mockImplementation((_sessionId: string, runId: string) => {
      if (runId === 'wf_newer123-abc') {
        return Promise.reject(new Error('newest artifact is missing'))
      }
      return Promise.resolve({
        runId,
        sessionId: SESSION_ID,
        workflowName: 'older-audit',
        scriptPath: '/tmp/older-audit.js',
        startedAt: 1,
        completedAgents: 1,
        script: SCRIPT,
        agents: [],
      })
    })
    render(
      <WorkflowSavePanel
        sessionId={SESSION_ID}
        cwd="/repo"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText(/newest artifact is missing/)).toBeInTheDocument()
    const runs = screen.getByRole('combobox', { name: 'Completed run' })
    expect(runs).toHaveValue('workflow-task-newer')
    fireEvent.change(runs, { target: { value: 'workflow-task-older' } })

    await waitFor(() => {
      expect(getRunMock).toHaveBeenCalledWith(SESSION_ID, 'wf_older123-abc')
    })
    expect(await screen.findByRole('textbox', { name: 'Command name' })).toHaveValue('older-audit')
  })
})
