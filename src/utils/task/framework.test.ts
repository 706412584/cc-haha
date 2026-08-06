import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { RemoteAgentTaskState } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { TaskState } from '../../tasks/types.js'
import type { SessionId } from '../../types/ids.js'
import { drainSdkEvents } from '../sdkEventQueue.js'
import { registerTask } from './framework.js'

beforeEach(() => {
  resetStateForTests()
  setIsInteractive(false)
  switchSession('remote-agent-task-started' as SessionId)
  drainSdkEvents()
})

afterEach(() => {
  drainSdkEvents()
  resetStateForTests()
})

test('includes the remote session id in remote Agent start events', () => {
  let state = { tasks: {} } as AppState
  const task = {
    id: 'remote-task-1',
    type: 'remote_agent',
    status: 'running',
    description: 'Review provider failures',
    sessionId: 'remote-session-1',
    toolUseId: 'remote-tool-1',
  } as RemoteAgentTaskState

  registerTask(task, (updater) => {
    state = updater(state)
  })

  expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
    type: 'system',
    subtype: 'task_started',
    task_id: 'remote-task-1',
    task_type: 'remote_agent',
    remote_session_id: 'remote-session-1',
  }))
})

function makeTask(
  overrides: Partial<TaskState> & Pick<TaskState, 'id' | 'type'>,
): TaskState {
  return {
    status: 'running',
    description: 'Background work',
    startTime: 1,
    outputFile: '/tmp/task.output',
    outputOffset: 0,
    notified: false,
    ...overrides,
  } as unknown as TaskState
}

function makeHarness() {
  let state = { tasks: {} } as unknown as AppState
  return {
    get state() {
      return state
    },
    setAppState(updater: (prev: AppState) => AppState) {
      state = updater(state)
    },
  }
}

test('emits a task_started event for a main-thread shell task', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'main-shell-task',
    type: 'local_bash',
    toolUseId: 'main-shell-tool',
  })

  registerTask(task, harness.setAppState)

  expect(harness.state.tasks['main-shell-task']).toBe(task)
  expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
    type: 'system',
    subtype: 'task_started',
    task_id: 'main-shell-task',
    tool_use_id: 'main-shell-tool',
    task_type: 'local_bash',
  }))
})

test('does not expose a subagent-owned shell task as a session background task', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'subagent-shell-task',
    type: 'local_bash',
    toolUseId: 'subagent-shell-tool',
    agentId: 'subagent-1',
  })

  registerTask(task, harness.setAppState)

  expect(harness.state.tasks['subagent-shell-task']).toBe(task)
  expect(drainSdkEvents()).toEqual([])
})

test('still exposes a local agent task in the session activity stream', () => {
  const harness = makeHarness()
  const task = makeTask({
    id: 'subagent-task',
    type: 'local_agent',
    toolUseId: 'agent-tool',
    agentId: 'subagent-task',
  })

  registerTask(task, harness.setAppState)

  expect(drainSdkEvents()).toContainEqual(expect.objectContaining({
    type: 'system',
    subtype: 'task_started',
    task_id: 'subagent-task',
    tool_use_id: 'agent-tool',
    task_type: 'local_agent',
  }))
})

test('keeps the original Agent tool_use id when a resume re-registers the task', () => {
  const harness = makeHarness()
  const spawned = makeTask({
    id: 'resumable-agent',
    type: 'local_agent',
    toolUseId: 'toolu_agent',
    agentId: 'resumable-agent',
    retain: true,
  })
  registerTask(spawned, harness.setAppState)
  drainSdkEvents()

  // SendMessage resumes a stopped agent and re-registers it with its own id.
  const resumed = makeTask({
    id: 'resumable-agent',
    type: 'local_agent',
    toolUseId: 'toolu_sendmessage',
    agentId: 'resumable-agent',
    retain: false,
  })
  registerTask(resumed, harness.setAppState)

  expect(harness.state.tasks['resumable-agent']?.toolUseId).toBe('toolu_agent')
  expect(drainSdkEvents()).toEqual([])
})
