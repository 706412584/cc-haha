import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cliTasksApi } from '../api/cliTasks'
import type { CLITask, TaskStatus } from '../types/cliTask'
import { useCLITaskStore } from './cliTaskStore'

vi.mock('../api/cliTasks', () => ({
  cliTasksApi: {
    getTasksForList: vi.fn(),
    resetTaskList: vi.fn(),
  },
}))

function makeTask(taskListId: string, status: TaskStatus = 'in_progress'): CLITask {
  return {
    id: '1',
    subject: 'Keep current session isolated',
    description: '',
    status,
    blocks: [],
    blockedBy: [],
    taskListId,
  }
}

describe('cliTaskStore', () => {
  beforeEach(() => {
    useCLITaskStore.getState().clearTasks()
    vi.clearAllMocks()
  })

  afterEach(() => {
    useCLITaskStore.getState().clearTasks()
  })

  it('clears stale tasks immediately when switching tracked sessions', async () => {
    let resolveRequest: ((value: { tasks: ReturnType<typeof makeTask>[] }) => void) | null = null

    vi.mocked(cliTasksApi.getTasksForList).mockImplementation(
      (sessionId: string) =>
        new Promise<{ tasks: ReturnType<typeof makeTask>[] }>((resolve) => {
          if (sessionId === 'session-2') resolveRequest = resolve
        }),
    )

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1')],
      expanded: true,
      completedAndDismissed: true,
      dismissedCompletionKey: 'session-1::done',
    })

    const fetchPromise = useCLITaskStore.getState().fetchSessionTasks('session-2')

    expect(useCLITaskStore.getState()).toMatchObject({
      sessionId: 'session-2',
      tasks: [],
      expanded: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    expect(resolveRequest).not.toBeNull()
    resolveRequest!({ tasks: [makeTask('session-2', 'completed')] })
    await fetchPromise

    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-2', status: 'completed' },
    ])
  })

  it('resets a completed task list locally before clearing it remotely', async () => {
    let resolveReset: ((value: { ok: true, reset: true }) => void) | null = null

    vi.mocked(cliTasksApi.resetTaskList).mockImplementation(
      () => new Promise<{ ok: true, reset: true }>((resolve) => {
        resolveReset = resolve
      }),
    )

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [
        makeTask('session-1', 'completed'),
        { ...makeTask('session-1', 'completed'), id: '2', subject: 'Second completed task' },
      ],
      expanded: true,
      completedAndDismissed: true,
      dismissedCompletionKey: 'session-1::done',
    })

    const resetPromise = useCLITaskStore.getState().resetCompletedTasks()

    expect(vi.mocked(cliTasksApi.resetTaskList)).toHaveBeenCalledWith('session-1', [
      {
        id: '1',
        subject: 'Keep current session isolated',
        description: '',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      },
      {
        id: '2',
        subject: 'Second completed task',
        description: '',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      },
    ])
    expect(useCLITaskStore.getState()).toMatchObject({
      tasks: [],
      resetting: true,
      completedAndDismissed: true,
      dismissedCompletionKey: 'session-1::1::Keep current session isolated::completed::::|session-1::2::Second completed task::completed::::',
      expanded: false,
    })

    expect(resolveReset).not.toBeNull()
    resolveReset!({ ok: true, reset: true })
    await resetPromise

    expect(useCLITaskStore.getState().resetting).toBe(false)
  })

  it('keeps a dismissed completed list hidden if polling returns it again', async () => {
    const completedTasks = [
      makeTask('session-1', 'completed'),
      { ...makeTask('session-1', 'completed'), id: '2', subject: 'Second completed task' },
    ]

    vi.mocked(cliTasksApi.resetTaskList).mockResolvedValue({ ok: true, reset: true })
    vi.mocked(cliTasksApi.getTasksForList).mockResolvedValue({ tasks: completedTasks })

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: completedTasks,
      expanded: true,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    await useCLITaskStore.getState().resetCompletedTasks()
    await useCLITaskStore.getState().fetchSessionTasks('session-1')

    expect(useCLITaskStore.getState()).toMatchObject({
      tasks: completedTasks,
      completedAndDismissed: true,
      dismissedCompletionKey: 'session-1::1::Keep current session isolated::completed::::|session-1::2::Second completed task::completed::::',
      expanded: false,
    })
  })

  it('refreshes tasks for the currently tracked session by default', async () => {
    vi.mocked(cliTasksApi.getTasksForList).mockResolvedValue({
      tasks: [makeTask('session-1', 'in_progress')],
    })

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [],
      expanded: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    await useCLITaskStore.getState().refreshTasks()

    expect(cliTasksApi.getTasksForList).toHaveBeenCalledWith('session-1')
    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-1', status: 'in_progress' },
    ])
  })

  it('shares one in-flight task request per session across polling and refreshes', async () => {
    let resolveRequest: ((value: { tasks: CLITask[] }) => void) | null = null
    vi.mocked(cliTasksApi.getTasksForList).mockImplementation(
      () => new Promise<{ tasks: CLITask[] }>((resolve) => {
        resolveRequest = resolve
      }),
    )

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [],
      expanded: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    const firstPoll = useCLITaskStore.getState().fetchSessionTasks('session-1')
    const secondPoll = useCLITaskStore.getState().fetchSessionTasks('session-1')
    const toolRefresh = useCLITaskStore.getState().refreshTasks('session-1')

    expect(cliTasksApi.getTasksForList).toHaveBeenCalledTimes(1)

    resolveRequest!({ tasks: [makeTask('session-1')] })
    await Promise.all([firstPoll, secondPoll, toolRefresh])

    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-1', status: 'in_progress' },
    ])

    vi.mocked(cliTasksApi.getTasksForList).mockResolvedValue({ tasks: [] })
    await useCLITaskStore.getState().refreshTasks('session-1')

    expect(cliTasksApi.getTasksForList).toHaveBeenCalledTimes(2)
  })

  it('releases a failed in-flight request so the next refresh can retry', async () => {
    vi.mocked(cliTasksApi.getTasksForList)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ tasks: [makeTask('session-1')] })

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [],
      expanded: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    await useCLITaskStore.getState().refreshTasks('session-1')
    await useCLITaskStore.getState().refreshTasks('session-1')

    expect(cliTasksApi.getTasksForList).toHaveBeenCalledTimes(2)
    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-1', status: 'in_progress' },
    ])
  })

  it('keeps requests for different sessions independent', async () => {
    vi.mocked(cliTasksApi.getTasksForList).mockImplementation(
      async (sessionId: string) => ({ tasks: [makeTask(sessionId)] }),
    )

    await Promise.all([
      useCLITaskStore.getState().fetchSessionTasks('session-1'),
      useCLITaskStore.getState().fetchSessionTasks('session-2'),
    ])

    expect(cliTasksApi.getTasksForList).toHaveBeenCalledTimes(2)
    expect(cliTasksApi.getTasksForList).toHaveBeenCalledWith('session-1')
    expect(cliTasksApi.getTasksForList).toHaveBeenCalledWith('session-2')
  })

  it('ignores an old response after leaving and re-entering the same session', async () => {
    const resolvers = new Map<string, Array<(value: { tasks: CLITask[] }) => void>>()
    vi.mocked(cliTasksApi.getTasksForList).mockImplementation(
      (sessionId: string) => new Promise<{ tasks: CLITask[] }>((resolve) => {
        const pending = resolvers.get(sessionId) ?? []
        pending.push(resolve)
        resolvers.set(sessionId, pending)
      }),
    )

    const oldSessionA = useCLITaskStore.getState().fetchSessionTasks('session-a')
    const sessionB = useCLITaskStore.getState().fetchSessionTasks('session-b')
    const newSessionA = useCLITaskStore.getState().fetchSessionTasks('session-a')

    expect(cliTasksApi.getTasksForList).toHaveBeenCalledTimes(3)

    resolvers.get('session-a')?.[0]?.({
      tasks: [{ ...makeTask('session-a'), subject: 'stale task' }],
    })
    await oldSessionA
    expect(useCLITaskStore.getState().tasks).toEqual([])

    resolvers.get('session-a')?.[1]?.({
      tasks: [{ ...makeTask('session-a'), subject: 'current task' }],
    })
    resolvers.get('session-b')?.[0]?.({ tasks: [makeTask('session-b')] })
    await Promise.all([sessionB, newSessionA])

    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-a', subject: 'current task' },
    ])
  })

  it('does not reuse a request from before task tracking was cleared', async () => {
    const resolvers: Array<(value: { tasks: CLITask[] }) => void> = []
    vi.mocked(cliTasksApi.getTasksForList).mockImplementation(
      () => new Promise<{ tasks: CLITask[] }>((resolve) => {
        resolvers.push(resolve)
      }),
    )

    const oldRequest = useCLITaskStore.getState().fetchSessionTasks('session-1')
    useCLITaskStore.getState().clearTasks('session-1')
    const newRequest = useCLITaskStore.getState().fetchSessionTasks('session-1')

    expect(cliTasksApi.getTasksForList).toHaveBeenCalledTimes(2)

    resolvers[0]?.({ tasks: [{ ...makeTask('session-1'), subject: 'stale task' }] })
    await oldRequest
    expect(useCLITaskStore.getState().tasks).toEqual([])

    resolvers[1]?.({ tasks: [{ ...makeTask('session-1'), subject: 'current task' }] })
    await newRequest
    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-1', subject: 'current task' },
    ])
  })

  it('does not let an older poll overwrite a newer TodoWrite update', async () => {
    let resolveRequest: ((value: { tasks: CLITask[] }) => void) | null = null
    vi.mocked(cliTasksApi.getTasksForList).mockImplementation(
      () => new Promise<{ tasks: CLITask[] }>((resolve) => {
        resolveRequest = resolve
      }),
    )

    const poll = useCLITaskStore.getState().fetchSessionTasks('session-1')
    useCLITaskStore.getState().setTasksFromTodos([
      { content: 'new task from tool', status: 'in_progress' },
    ], 'session-1')

    resolveRequest!({
      tasks: [{ ...makeTask('session-1'), subject: 'stale task from poll' }],
    })
    await poll

    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-1', subject: 'new task from tool' },
    ])
  })

  it('does not start task refreshes while a completed-list reset is pending', async () => {
    let resolveReset: ((value: { ok: true, reset: true }) => void) | null = null
    vi.mocked(cliTasksApi.resetTaskList).mockImplementation(
      () => new Promise<{ ok: true, reset: true }>((resolve) => {
        resolveReset = resolve
      }),
    )

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1', 'completed')],
      expanded: true,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    const reset = useCLITaskStore.getState().resetCompletedTasks('session-1')
    await Promise.all([
      useCLITaskStore.getState().fetchSessionTasks('session-1'),
      useCLITaskStore.getState().refreshTasks('session-1'),
    ])

    expect(cliTasksApi.getTasksForList).not.toHaveBeenCalled()

    resolveReset!({ ok: true, reset: true })
    await reset
    expect(useCLITaskStore.getState().resetting).toBe(false)
  })

  it('lets a new TodoWrite cycle supersede a pending completed-list reset', async () => {
    let resolveReset: ((value: { ok: true, reset: true }) => void) | null = null
    vi.mocked(cliTasksApi.resetTaskList).mockImplementation(
      () => new Promise<{ ok: true, reset: true }>((resolve) => {
        resolveReset = resolve
      }),
    )

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1', 'completed')],
      expanded: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    const reset = useCLITaskStore.getState().resetCompletedTasks('session-1')
    useCLITaskStore.getState().setTasksFromTodos([
      { content: 'new cycle', status: 'in_progress' },
    ], 'session-1')

    expect(useCLITaskStore.getState()).toMatchObject({
      resetting: false,
      tasks: [{ subject: 'new cycle', status: 'in_progress' }],
    })

    resolveReset!({ ok: true, reset: true })
    await reset
    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { subject: 'new cycle', status: 'in_progress' },
    ])
  })

  it('refreshes preserved tasks when the server rejects a stale reset snapshot', async () => {
    vi.mocked(cliTasksApi.resetTaskList).mockResolvedValue({ ok: true, reset: false })
    vi.mocked(cliTasksApi.getTasksForList).mockResolvedValue({
      tasks: [{ ...makeTask('session-1'), subject: 'new task from disk' }],
    })

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1', 'completed')],
      expanded: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    await useCLITaskStore.getState().resetCompletedTasks('session-1')

    expect(cliTasksApi.getTasksForList).toHaveBeenCalledWith('session-1')
    expect(useCLITaskStore.getState()).toMatchObject({
      resetting: false,
      completedAndDismissed: false,
      tasks: [{ subject: 'new task from disk', status: 'in_progress' }],
    })
  })

  it('restores completed tasks when the remote reset request fails', async () => {
    vi.mocked(cliTasksApi.resetTaskList).mockRejectedValue(new Error('reset failed'))
    const completedTasks = [makeTask('session-1', 'completed')]

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: completedTasks,
      expanded: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    await useCLITaskStore.getState().resetCompletedTasks('session-1')

    expect(useCLITaskStore.getState()).toMatchObject({
      tasks: completedTasks,
      resetting: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })
  })

  it('preserves known tasks when polling fails transiently', async () => {
    const knownTasks = [makeTask('session-1', 'in_progress')]
    vi.mocked(cliTasksApi.getTasksForList).mockRejectedValueOnce(new Error('temporary failure'))

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: knownTasks,
      expanded: true,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    await useCLITaskStore.getState().fetchSessionTasks('session-1')

    expect(useCLITaskStore.getState()).toMatchObject({
      sessionId: 'session-1',
      tasks: knownTasks,
      expanded: true,
    })
  })

  it('stays empty when the initial fetch for a new session fails', async () => {
    vi.mocked(cliTasksApi.getTasksForList).mockRejectedValueOnce(new Error('temporary failure'))

    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1', 'in_progress')],
      expanded: true,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    await useCLITaskStore.getState().fetchSessionTasks('session-2')

    expect(useCLITaskStore.getState()).toMatchObject({
      sessionId: 'session-2',
      tasks: [],
      expanded: false,
    })
  })

  it('marks completed tasks dismissed for the currently tracked session by default', () => {
    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1', 'completed')],
      expanded: true,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    useCLITaskStore.getState().markCompletedAndDismissed()

    expect(useCLITaskStore.getState()).toMatchObject({
      completedAndDismissed: true,
      dismissedCompletionKey: 'session-1::1::Keep current session isolated::completed::::',
      expanded: false,
    })
  })

  it('ignores TodoWrite updates for a session that is not currently tracked', () => {
    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1', 'in_progress')],
      expanded: true,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    useCLITaskStore.getState().setTasksFromTodos([
      { content: 'Session 2 task', status: 'completed' },
    ], 'session-2')

    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-1', subject: 'Keep current session isolated' },
    ])
  })

  it('does not reset completed tasks for a different session', async () => {
    useCLITaskStore.setState({
      sessionId: 'session-1',
      tasks: [makeTask('session-1', 'completed')],
      expanded: true,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
    })

    await useCLITaskStore.getState().resetCompletedTasks('session-2')

    expect(vi.mocked(cliTasksApi.resetTaskList)).not.toHaveBeenCalled()
    expect(useCLITaskStore.getState().tasks).toMatchObject([
      { taskListId: 'session-1', status: 'completed' },
    ])
  })
})
