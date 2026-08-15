import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setIsInteractive,
  setSdkAgentProgressSummariesEnabled,
  switchSession,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppStateStore.js'
import { createTaskStateBase } from '../../Task.js'
import type { CustomAgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { SessionId } from '../../types/ids.js'
import {
  dequeue,
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { _clearOutputsForTest } from '../../utils/task/diskOutput.js'
import {
  backgroundAgentTask,
  enqueueAgentNotification,
  type LocalAgentTaskState,
  registerAgentForeground,
  registerAsyncAgent,
  updateAgentSummary,
} from './LocalAgentTask.js'

const selectedAgent = {
  agentType: 'general-purpose',
  whenToUse: 'Test task registration',
  rawSystemPrompt: 'Inspect ownership',
  getSystemPrompt: () => 'Inspect ownership',
  source: 'projectSettings',
} satisfies CustomAgentDefinition

function makeHarness(ownerAgentId?: string) {
  const taskId = ownerAgentId ? 'nested-agent' : 'root-agent'
  const task: LocalAgentTaskState = {
    ...createTaskStateBase(taskId, 'local_agent', 'Inspect ownership', 'toolu_agent'),
    type: 'local_agent',
    status: 'running',
    ownerAgentId,
    agentId: taskId,
    prompt: 'Inspect ownership',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }
  let state = {
    tasks: { [taskId]: task },
    speculation: IDLE_SPECULATION_STATE,
  } as unknown as AppState
  return {
    taskId,
    get state() {
      return state
    },
    setAppState(updater: (prev: AppState) => AppState) {
      state = updater(state)
    },
  }
}

function makeEmptyHarness() {
  let state = {
    tasks: {},
    speculation: IDLE_SPECULATION_STATE,
  } as unknown as AppState
  return {
    get state() {
      return state
    },
    setAppState(updater: (prev: AppState) => AppState) {
      state = updater(state)
    },
  }
}

beforeEach(() => {
  resetStateForTests()
  resetCommandQueue()
  setIsInteractive(false)
  switchSession('local-agent-owner-test' as SessionId)
  drainSdkEvents()
})

afterEach(async () => {
  await _clearOutputsForTest()
  setSdkAgentProgressSummariesEnabled(false)
  drainSdkEvents()
  resetCommandQueue()
  resetStateForTests()
})

describe('enqueueAgentNotification ownership', () => {
  test('keeps a root agent terminal notification on the main-thread path', () => {
    const harness = makeHarness()

    enqueueAgentNotification({
      taskId: harness.taskId,
      description: 'Inspect ownership',
      status: 'completed',
      setAppState: harness.setAppState,
      toolUseId: 'toolu_agent',
    })

    expect(getCommandQueue()).toHaveLength(1)
    expect(getCommandQueue()[0]?.agentId).toBeUndefined()
    expect(drainSdkEvents()).toEqual([])
  })

  test('routes a nested terminal to its parent and emits owned SDK metadata', () => {
    const harness = makeHarness('parent-agent')

    enqueueAgentNotification({
      taskId: harness.taskId,
      description: 'Inspect ownership',
      status: 'completed',
      setAppState: harness.setAppState,
      toolUseId: 'toolu_agent',
      finalMessage: 'Ownership verified',
    })

    expect(getCommandQueue()).toHaveLength(1)
    expect(getCommandQueue()[0]?.agentId).toBe('parent-agent')
    expect(String(getCommandQueue()[0]?.value)).toContain(
      '<result>Ownership verified</result>',
    )
    expect(drainSdkEvents()).toEqual([
      expect.objectContaining({
        subtype: 'task_notification',
        task_id: 'nested-agent',
        tool_use_id: 'toolu_agent',
        status: 'completed',
        owner_agent_id: 'parent-agent',
      }),
    ])
    expect(
      dequeue((command) => command.agentId === 'parent-agent')?.agentId,
    ).toBe('parent-agent')
    expect(getCommandQueue()).toEqual([])
  })

  test('keeps summary progress scoped to the nested agent owner', () => {
    const harness = makeHarness('parent-agent')
    setSdkAgentProgressSummariesEnabled(true)

    updateAgentSummary(
      harness.taskId,
      'Checked provider ownership',
      harness.setAppState,
    )

    expect(
      (harness.state.tasks[harness.taskId] as LocalAgentTaskState).progress
        ?.summary,
    ).toBe('Checked provider ownership')
    expect(drainSdkEvents()).toEqual([
      expect.objectContaining({
        subtype: 'task_progress',
        task_id: 'nested-agent',
        summary: 'Checked provider ownership',
        owner_agent_id: 'parent-agent',
      }),
    ])
  })
})

describe('Agent task registration ownership', () => {
  test('persists the immediate owner for async and foreground registrations', async () => {
    const harness = makeEmptyHarness()
    const asyncTask = registerAsyncAgent({
      agentId: 'async-owned-agent',
      description: 'Async owned task',
      prompt: 'Inspect async ownership',
      selectedAgent,
      setAppState: harness.setAppState,
      toolUseId: 'toolu_async_owned',
      ownerAgentId: 'parent-agent-run',
    })

    expect(asyncTask.ownerAgentId).toBe('parent-agent-run')
    expect(
      (harness.state.tasks['async-owned-agent'] as LocalAgentTaskState)
        .ownerAgentId,
    ).toBe('parent-agent-run')
    asyncTask.unregisterCleanup?.()

    const foreground = registerAgentForeground({
      agentId: 'foreground-owned-agent',
      description: 'Foreground owned task',
      prompt: 'Inspect foreground ownership',
      selectedAgent,
      setAppState: harness.setAppState,
      toolUseId: 'toolu_foreground_owned',
      ownerAgentId: 'parent-agent-run',
    })
    const foregroundTask = harness.state.tasks[
      'foreground-owned-agent'
    ] as LocalAgentTaskState

    expect(foregroundTask.ownerAgentId).toBe('parent-agent-run')
    foregroundTask.unregisterCleanup?.()
    expect(
      backgroundAgentTask(
        foreground.taskId,
        () => harness.state,
        harness.setAppState,
      ),
    ).toBe(true)
    await foreground.backgroundSignal
  })
})
