import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  resetStateForTests,
  setIsInteractive,
  switchSession,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppStateStore.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { SessionId } from '../../types/ids.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { resetProjectForTesting } from '../../utils/sessionStorage.js'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  cleanupTaskOutput,
} from '../../utils/task/diskOutput.js'
import { prepareWorkflowScript } from '../../utils/workflows/runtime.js'
import {
  killWorkflowTask,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { launchWorkflow } from './launchWorkflow.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

describe('launchWorkflow lifecycle ownership', () => {
  let configDir = ''
  let launchedTaskIds = new Set<string>()

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-owner-'))
    launchedTaskIds = new Set()
    process.env.CLAUDE_CONFIG_DIR = configDir
    _resetTaskOutputDirForTest()
    resetProjectForTesting()
    resetStateForTests()
    resetCommandQueue()
    setIsInteractive(false)
    switchSession('workflow-owner-test' as SessionId)
    drainSdkEvents()
  })

  afterEach(async () => {
    await _clearOutputsForTest()
    await Promise.all([...launchedTaskIds].map(cleanupTaskOutput))
    _resetTaskOutputDirForTest()
    drainSdkEvents()
    resetCommandQueue()
    resetStateForTests()
    resetProjectForTesting()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(configDir, { recursive: true, force: true })
  })

  function launch(options: {
    taskId: string
    scriptBody: string
    ownerAgentId?: string
  }): {
    published: Promise<LocalWorkflowTaskState>
    setAppState: (updater: (state: AppState) => AppState) => void
  } {
    launchedTaskIds.add(options.taskId)
    const script = [
      "export const meta = { name: 'owner-test', description: 'Owner test' }",
      options.scriptBody,
    ].join('\n')
    const prepared = prepareWorkflowScript(script)
    if (!prepared.ok) throw new Error(prepared.error)
    let state = {
      tasks: {},
      toolPermissionContext: getEmptyToolPermissionContext(),
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    let resolvePublished: (task: LocalWorkflowTaskState) => void = () => {}
    let didPublish = false
    const published = new Promise<LocalWorkflowTaskState>(resolve => {
      resolvePublished = resolve
    })
    const setAppState = (updater: (current: AppState) => AppState): void => {
      state = updater(state)
      const task = state.tasks[options.taskId] as
        | LocalWorkflowTaskState
        | undefined
      if (
        !didPublish &&
        task &&
        isTerminalTaskStatus(task.status) &&
        task.notified
      ) {
        didPublish = true
        resolvePublished(task)
      }
    }
    const context = {
      agentId: options.ownerAgentId,
      toolUseId: 'workflow-leaf-tool',
      abortController: new AbortController(),
      setAppState,
      getAppState: () => state,
      options: { mainLoopModel: 'test-model', tools: [] },
    } as unknown as ToolUseContext

    launchWorkflow({
      taskId: options.taskId,
      workflowRunId: `wf_${options.taskId}-owner`,
      script,
      scriptPath: path.join(configDir, `${options.taskId}.js`),
      meta: prepared.meta,
      vmScript: prepared.vmScript,
      toolUseContext: context,
      canUseTool: (() => {}) as never,
      toolUseId: 'workflow-leaf-tool',
      isResume: false,
    })
    return {
      published,
      setAppState,
    }
  }

  test('keeps a nested workflow owned from start through progress and completion', async () => {
    const run = launch({
      taskId: 'w-owned-complete',
      ownerAgentId: 'parent-agent',
      scriptBody: "phase('Scan')\nreturn 'done'",
    })
    expect((await run.published).status).toBe('completed')

    const lifecycle = drainSdkEvents().filter(event => (
      'task_id' in event && event.task_id === 'w-owned-complete'
    ))
    expect(lifecycle.map(event => event.subtype)).toEqual([
      'task_started',
      'task_progress',
      'task_notification',
    ])
    expect(lifecycle.every(event => (
      'owner_agent_id' in event && event.owner_agent_id === 'parent-agent'
    ))).toBe(true)
    expect(getCommandQueue()[0]?.agentId).toBe('parent-agent')
  })

  test('keeps nested failure and kill terminal bookends owned', async () => {
    const failed = launch({
      taskId: 'w-owned-failed',
      ownerAgentId: 'parent-agent',
      scriptBody: "throw new Error('workflow exploded')",
    })
    expect((await failed.published).status).toBe('failed')

    const killed = launch({
      taskId: 'w-owned-killed',
      ownerAgentId: 'parent-agent',
      scriptBody: "return 'too late'",
    })
    expect(killWorkflowTask('w-owned-killed', killed.setAppState)).toBe(true)
    expect((await killed.published).status).toBe('killed')

    const terminals = drainSdkEvents().filter(event => (
      event.subtype === 'task_notification' &&
      'task_id' in event &&
      (event.task_id === 'w-owned-failed' || event.task_id === 'w-owned-killed')
    ))
    expect(terminals).toEqual([
      expect.objectContaining({
        task_id: 'w-owned-failed',
        status: 'failed',
        owner_agent_id: 'parent-agent',
      }),
      expect.objectContaining({
        task_id: 'w-owned-killed',
        status: 'stopped',
        owner_agent_id: 'parent-agent',
      }),
    ])
    expect(getCommandQueue().map(command => command.agentId)).toEqual([
      'parent-agent',
      'parent-agent',
    ])
  })

  test('leaves a root workflow on the legacy root notification path', async () => {
    const run = launch({
      taskId: 'w-root-complete',
      scriptBody: "phase('Root')\nreturn 'done'",
    })
    expect((await run.published).status).toBe('completed')

    const lifecycle = drainSdkEvents().filter(event => (
      'task_id' in event && event.task_id === 'w-root-complete'
    ))
    expect(lifecycle.map(event => event.subtype)).toEqual([
      'task_started',
      'task_progress',
    ])
    expect(lifecycle.every(event => !('owner_agent_id' in event))).toBe(true)
    expect(getCommandQueue()[0]?.agentId).toBeUndefined()
  })
})
