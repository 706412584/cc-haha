import { create } from 'zustand'
import { cliTasksApi } from '../api/cliTasks'
import type { CLITask, TaskStatus } from '../types/cliTask'

type TodoItem = {
  content: string
  status: string
  activeForm?: string
}

type CLITaskStore = {
  /** Current session ID being tracked */
  sessionId: string | null
  /** Tasks for the current session */
  tasks: CLITask[]
  /** True while the persisted task list is being cleared remotely */
  resetting: boolean
  /** Whether the task bar is expanded */
  expanded: boolean
  /** True when all tasks completed and the user already continued chatting.
   *  Set during history load so the sticky bar is suppressed on page refresh. */
  completedAndDismissed: boolean
  /** Snapshot of the completed task set that was dismissed */
  dismissedCompletionKey: string | null

  /** Fetch tasks for a given session (uses sessionId as taskListId) */
  fetchSessionTasks: (sessionId: string) => Promise<void>
  /** Refresh tasks for the currently tracked session, or a specific session if provided */
  refreshTasks: (sessionId?: string) => Promise<void>
  /** Update tasks from TodoWrite V1 tool input (in-memory, no disk read needed) */
  setTasksFromTodos: (todos: TodoItem[], sessionId?: string) => void
  /** Mark that completed tasks were already dismissed (conversation continued) */
  markCompletedAndDismissed: (sessionId?: string) => void
  /** Clear a completed task list locally and remotely so the next cycle starts clean */
  resetCompletedTasks: (sessionId?: string) => Promise<void>
  /** Clear task tracking state */
  clearTasks: (sessionId?: string) => void
  /** Toggle expanded state */
  toggleExpanded: () => void
}

function buildCompletedTaskKey(tasks: CLITask[]): string | null {
  if (tasks.length === 0 || tasks.some((task) => task.status !== 'completed')) return null

  return tasks
    .map((task) => [
      task.taskListId,
      task.id,
      task.subject,
      task.status,
      task.activeForm ?? '',
      task.owner ?? '',
    ].join('::'))
    .join('|')
}

function resolveDismissState(tasks: CLITask[], dismissedCompletionKey: string | null) {
  const completionKey = buildCompletedTaskKey(tasks)
  const keepDismissed = completionKey !== null && completionKey === dismissedCompletionKey

  return {
    completedAndDismissed: keepDismissed,
    dismissedCompletionKey: keepDismissed ? completionKey : null,
  }
}

function mapTodosToTasks(todos: TodoItem[], sessionId: string | null): CLITask[] {
  return todos.map((todo, index) => ({
    id: String(index + 1),
    subject: todo.content,
    description: '',
    activeForm: todo.activeForm,
    status: (['pending', 'in_progress', 'completed'].includes(todo.status)
      ? todo.status
      : 'pending') as TaskStatus,
    blocks: [],
    blockedBy: [],
    taskListId: sessionId || '',
  }))
}

type InFlightTaskRequest = {
  generation: number
  promise: Promise<{ tasks: CLITask[] }>
}

const inFlightTaskRequests = new Map<string, InFlightTaskRequest>()
let trackingGeneration = 0

function getTasksForSession(
  sessionId: string,
  generation: number,
): Promise<{ tasks: CLITask[] }> {
  const pending = inFlightTaskRequests.get(sessionId)
  if (pending?.generation === generation) return pending.promise

  const promise = cliTasksApi.getTasksForList(sessionId)
  const request = { generation, promise }
  inFlightTaskRequests.set(sessionId, request)
  void promise.finally(() => {
    if (inFlightTaskRequests.get(sessionId) === request) {
      inFlightTaskRequests.delete(sessionId)
    }
  }).catch(() => {})
  return promise
}

export const useCLITaskStore = create<CLITaskStore>((set, get) => ({
  sessionId: null,
  tasks: [],
  resetting: false,
  expanded: false,
  completedAndDismissed: false,
  dismissedCompletionKey: null,

  fetchSessionTasks: async (sessionId) => {
    let generation = trackingGeneration
    if (get().sessionId !== sessionId) {
      generation = ++trackingGeneration
      set({
        sessionId,
        tasks: [],
        resetting: false,
        completedAndDismissed: false,
        dismissedCompletionKey: null,
        expanded: false,
      })
    }
    if (get().resetting) return

    try {
      const { tasks } = await getTasksForSession(sessionId, generation)
      // Only update if this response belongs to the current tracking cycle.
      if (
        trackingGeneration === generation &&
        get().sessionId === sessionId &&
        !get().resetting
      ) {
        set((state) => ({
          tasks,
          ...resolveDismissState(tasks, state.dismissedCompletionKey),
        }))
      }
    } catch {
      // No tasks for this session — that's fine
      if (
        trackingGeneration === generation &&
        get().sessionId === sessionId &&
        !get().resetting
      ) {
        set({ tasks: [], completedAndDismissed: false, dismissedCompletionKey: null, expanded: false })
      }
    }
  },

  refreshTasks: async (targetSessionId) => {
    const sessionId = targetSessionId ?? get().sessionId
    if (!sessionId || get().resetting) return
    const generation = trackingGeneration
    try {
      const { tasks } = await getTasksForSession(sessionId, generation)
      if (
        trackingGeneration === generation &&
        get().sessionId === sessionId &&
        !get().resetting
      ) {
        set((state) => ({
          tasks,
          ...resolveDismissState(tasks, state.dismissedCompletionKey),
        }))
      }
    } catch {
      // ignore
    }
  },

  setTasksFromTodos: (todos, targetSessionId) => {
    const sessionId = targetSessionId ?? get().sessionId
    if (!sessionId || get().sessionId !== sessionId) return
    trackingGeneration += 1
    const tasks = mapTodosToTasks(todos, sessionId)
    set((state) => ({
      tasks,
      resetting: false,
      ...resolveDismissState(tasks, state.dismissedCompletionKey),
    }))
  },

  markCompletedAndDismissed: (targetSessionId) => {
    const sessionId = targetSessionId ?? get().sessionId
    if (!sessionId || get().sessionId !== sessionId) return
    const completionKey = buildCompletedTaskKey(get().tasks)
    if (!completionKey) return

    set({
      completedAndDismissed: true,
      dismissedCompletionKey: completionKey,
      expanded: false,
    })
  },

  resetCompletedTasks: async (targetSessionId) => {
    const sessionId = targetSessionId ?? get().sessionId
    if (!sessionId || get().sessionId !== sessionId) return
    const { tasks } = get()
    const completionKey = buildCompletedTaskKey(tasks)
    if (!completionKey) return

    const resetGeneration = ++trackingGeneration
    set({
      tasks: [],
      resetting: true,
      completedAndDismissed: true,
      dismissedCompletionKey: completionKey,
      expanded: false,
    })

    try {
      await cliTasksApi.resetTaskList(sessionId)
    } finally {
      if (
        trackingGeneration === resetGeneration &&
        get().sessionId === sessionId
      ) {
        set({ resetting: false })
      }
    }
  },

  clearTasks: (targetSessionId) => {
    if (targetSessionId && get().sessionId !== targetSessionId) return
    trackingGeneration += 1
    set({
      sessionId: null,
      tasks: [],
      resetting: false,
      completedAndDismissed: false,
      dismissedCompletionKey: null,
      expanded: false,
    })
  },

  toggleExpanded: () => {
    set((s) => ({ expanded: !s.expanded }))
  },
}))
