import { api } from './client'
import type { CLITask, TaskListSummary } from '../types/cliTask'

type TaskListsResponse = { lists: TaskListSummary[] }
type TasksResponse = { tasks: CLITask[] }
type TaskResponse = { task: CLITask }

export const cliTasksApi = {
  /** List all task lists with summaries */
  listTaskLists() {
    return api.get<TaskListsResponse>('/api/tasks/lists')
  },

  /** Get all tasks for a specific task list */
  getTasksForList(taskListId: string) {
    return api.get<TasksResponse>(`/api/tasks/lists/${encodeURIComponent(taskListId)}`)
  },

  /** Get a single task */
  getTask(taskListId: string, taskId: string) {
    return api.get<TaskResponse>(`/api/tasks/lists/${encodeURIComponent(taskListId)}/${taskId}`)
  },

  /** Clear persisted tasks only if they still match the completed snapshot */
  resetTaskList(
    taskListId: string,
    expectedTasks: Array<Omit<CLITask, 'taskListId'>>,
  ) {
    return api.post<{ ok: true; reset: boolean }>(
      `/api/tasks/lists/${encodeURIComponent(taskListId)}/reset`,
      { expectedTasks },
    )
  },

  /** List all tasks across all task lists */
  listAll() {
    return api.get<TasksResponse>('/api/tasks')
  },
}
