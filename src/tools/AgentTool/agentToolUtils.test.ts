import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setIsInteractive } from '../../bootstrap/state.js'
import * as sdkEventQueue from '../../utils/sdkEventQueue.js'
import type { AppState } from '../../state/AppState.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppStateStore.js'
import { createTaskStateBase } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { Message } from '../../types/message.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  drainSdkEvents,
} from '../../utils/sdkEventQueue.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import {
  emitAgentToolActivitiesForMessage,
  extractAgentToolActivities,
  runAsyncAgentLifecycle,
} from './agentToolUtils.js'
import {
  completeAgentTask,
  drainAgentCompletionInbox,
  enqueueAgentNotification,
  killAsyncAgent,
  loadAgentRuntimeSnapshot,
  persistAgentRuntimeSnapshot,
  registerAsyncAgent,
  restoreAgentRuntimeSnapshot,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/SyntheticOutputTool.js'

describe('local Agent lifecycle epochs', () => {
  test('ignores completion from a cancelled epoch after the task restarts', () => {
    let appState = {
      tasks: {},
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const selectedAgent = { agentType: 'general-purpose' } as never

    const first = registerAsyncAgent({
      agentId: 'agent-epoch-race',
      description: 'Check epoch race',
      prompt: 'Check epoch race',
      selectedAgent,
      setAppState,
    })
    killAsyncAgent(first.agentId, setAppState)
    const second = registerAsyncAgent({
      agentId: first.agentId,
      description: 'Check epoch race again',
      prompt: 'Check epoch race again',
      selectedAgent,
      setAppState,
    })

    completeAgentTask({ agentId: first.agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, first.epoch)
    enqueueAgentNotification({ taskId: first.agentId, description: 'stale', status: 'completed', setAppState, epoch: first.epoch })
    expect(appState.tasks[first.agentId]?.status).toBe('running')
    expect(appState.agentCompletionInbox ?? []).toHaveLength(0)

    completeAgentTask({ agentId: second.agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, second.epoch)
    expect(appState.tasks[second.agentId]?.status).toBe('completed')
  })
})

describe('Agent runtime recovery', () => {
  test('marks orphaned running Agents interrupted and preserves only unconsumed completions', () => {
    const restored = restoreAgentRuntimeSnapshot({
      version: 1,
      nextSequence: 9,
      tasks: [{
        id: 'agent-restored-running',
        epoch: 3,
        status: 'running',
        description: 'Restore me',
        prompt: 'Restore me',
        agentType: 'general-purpose',
        startTime: 10,
        toolUseId: 'tool-restored-running',
      }],
      inbox: [{
        version: 1,
        sequence: 8,
        taskId: 'agent-restored-finished',
        epoch: 2,
        notification: '<task-notification>finished</task-notification>',
        consumed: false,
      }, {
        version: 1,
        sequence: 7,
        taskId: 'agent-restored-consumed',
        epoch: 1,
        notification: '<task-notification>consumed</task-notification>',
        consumed: true,
      }],
    })

    expect(restored.tasks['agent-restored-running']?.status).toBe('failed')
    expect((restored.tasks['agent-restored-running'] as LocalAgentTaskState).error).toContain('interrupted')
    expect(restored.agentCompletionInbox.map(item => item.taskId)).toEqual([
      'agent-restored-finished',
      'agent-restored-running',
    ])
    expect(restored.agentCompletionInbox[1]?.notification).toContain('<status>failed</status>')
    expect(restored.agentCompletionInbox[1]?.notification).toContain('interrupted')
    expect(restored.nextAgentCompletionSequence).toBe(10)
  })
})

describe('Agent runtime persistence', () => {
  test('round-trips 64 escaped tasks and inbox items within the reader byte limit', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-budget-'))
    const filePath = path.join(directory, 'runtime.json')
    try {
      const escapedText = '\n\\"\u0001'.repeat(1_000)
      const tasks = Object.fromEntries(Array.from({ length: 64 }, (_, index) => {
        const id = `agent-escaped-${String(index).padStart(2, '0')}`
        return [id, {
          ...createTaskStateBase(id, 'local_agent', escapedText),
          type: 'local_agent' as const,
          status: index < 4 ? 'running' as const : 'completed' as const,
          agentId: id,
          epoch: 1,
          prompt: escapedText,
          agentType: `general-purpose-${escapedText}`,
          error: escapedText,
          result: {
            agentId: id,
            agentType: escapedText,
            content: [{ type: 'text' as const, text: escapedText }],
            totalToolUseCount: 1,
            totalDurationMs: 1,
            totalTokens: 1,
            usage: {} as never,
          },
          retrieved: false,
          lastReportedToolCount: 0,
          lastReportedTokenCount: 0,
          isBackgrounded: true,
          pendingMessages: [],
          retain: false,
          diskLoaded: false,
        }]
      }))
      const inbox = Object.values(tasks).map((task, index) => ({
        version: 1 as const,
        sequence: index + 1,
        taskId: task.id,
        epoch: task.epoch,
        notification: escapedText,
      }))

      await persistAgentRuntimeSnapshot(filePath, {
        tasks,
        agentCompletionInbox: inbox,
        nextAgentCompletionSequence: 65,
      })

      expect((await fs.stat(filePath)).size).toBeLessThanOrEqual(2_000_000)
      expect(JSON.parse(await fs.readFile(filePath, 'utf8')).version).toBe(1)
      const restored = await loadAgentRuntimeSnapshot(filePath)
      expect(Object.keys(restored.tasks)).toHaveLength(64)
      for (let index = 0; index < 4; index++) {
        const id = `agent-escaped-${String(index).padStart(2, '0')}`
        expect(restored.tasks[id]?.status).toBe('failed')
      }
      expect(restored.agentCompletionInbox).toHaveLength(64)
      expect(restored.agentCompletionInbox[0]?.notification).toContain('persisted recovery summary')
      expect(restored.nextAgentCompletionSequence).toBeGreaterThanOrEqual(65)
      expect(tasks['agent-escaped-00']?.result?.content[0]?.text).toBe(escapedText)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test('round-trips a bounded snapshot and persists inbox consumption', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-'))
    const filePath = path.join(directory, 'runtime.json')
    try {
      const task = {
        ...createTaskStateBase('agent-persisted', 'local_agent', 'Persist me'),
        type: 'local_agent' as const,
        status: 'completed' as const,
        agentId: 'agent-persisted',
        epoch: 4,
        prompt: 'Persist me',
        agentType: 'general-purpose',
        retrieved: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
        isBackgrounded: true,
        pendingMessages: [],
        retain: false,
        diskLoaded: false,
      }
      await persistAgentRuntimeSnapshot(filePath, {
        tasks: { [task.id]: task },
        agentCompletionInbox: [{ version: 1, sequence: 2, taskId: task.id, epoch: task.epoch, notification: '<task-notification />' }],
        nextAgentCompletionSequence: 3,
      })
      expect((await loadAgentRuntimeSnapshot(filePath)).agentCompletionInbox).toHaveLength(1)

      await persistAgentRuntimeSnapshot(filePath, {
        tasks: { [task.id]: task },
        agentCompletionInbox: [],
        nextAgentCompletionSequence: 3,
      })
      expect((await loadAgentRuntimeSnapshot(filePath)).agentCompletionInbox).toHaveLength(0)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})

describe('bounded Agent registry', () => {
  test('evicts the oldest terminal Agent without evicting running Agents', () => {
    let appState = { tasks: {} } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const selectedAgent = { agentType: 'general-purpose' } as never
    for (let index = 0; index < 64; index++) {
      const agentId = `agent-registry-${String(index).padStart(2, '0')}`
      const task = registerAsyncAgent({ agentId, description: agentId, prompt: agentId, selectedAgent, setAppState })
      if (index < 63) {
        completeAgentTask({ agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
      }
    }

    registerAsyncAgent({ agentId: 'agent-registry-new', description: 'new', prompt: 'new', selectedAgent, setAppState })

    expect(appState.tasks['agent-registry-00']).toBeUndefined()
    expect(appState.tasks['agent-registry-63']?.status).toBe('running')
    expect(appState.tasks['agent-registry-new']?.status).toBe('running')
    expect(Object.values(appState.tasks).filter(task => task.type === 'local_agent')).toHaveLength(64)
  })
})

describe('Agent completion inbox', () => {
  test('drops an enqueued completion when the same task resumes at a newer epoch', () => {
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const selectedAgent = { agentType: 'general-purpose' } as never
    const first = registerAsyncAgent({
      agentId: 'agent-inbox-resumed',
      description: 'First epoch',
      prompt: 'First epoch',
      selectedAgent,
      setAppState,
    })
    completeAgentTask({ agentId: first.agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, first.epoch)
    enqueueAgentNotification({ taskId: first.agentId, description: 'First epoch', status: 'completed', setAppState, epoch: first.epoch })

    const second = registerAsyncAgent({
      agentId: first.agentId,
      description: 'Second epoch',
      prompt: 'Second epoch',
      selectedAgent,
      setAppState,
    })
    expect(second.epoch).toBe(first.epoch + 1)

    drainAgentCompletionInbox(setAppState)
    expect(getCommandQueue()).toHaveLength(0)
  })

  test('defers ordered completion injection until a continuation boundary and consumes once', () => {
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const selectedAgent = { agentType: 'general-purpose' } as never
    for (const [agentId, description] of [['agent-inbox-1', 'First'], ['agent-inbox-2', 'Second']] as const) {
      const task = registerAsyncAgent({ agentId, description, prompt: description, selectedAgent, setAppState })
      completeAgentTask({ agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
      enqueueAgentNotification({ taskId: agentId, description, status: 'completed', setAppState, epoch: task.epoch })
    }

    expect(getCommandQueue()).toHaveLength(0)
    expect(appState.agentCompletionInbox.map(item => item.taskId)).toEqual(['agent-inbox-1', 'agent-inbox-2'])

    drainAgentCompletionInbox(setAppState)
    expect(getCommandQueue().map(command => String(command.value))).toEqual([
      expect.stringContaining('<task-id>agent-inbox-1</task-id>'),
      expect.stringContaining('<task-id>agent-inbox-2</task-id>'),
    ])
    drainAgentCompletionInbox(setAppState)
    expect(getCommandQueue()).toHaveLength(2)
  })
})

describe('runAsyncAgentLifecycle', () => {
  afterEach(() => {
    resetCommandQueue()
    drainSdkEvents()
    setIsInteractive(true)
  })

  test('emits progress for assistant text even when no tool is used', async () => {
    setIsInteractive(false)
    const taskId = 'agent-text-progress'
    const abortController = new AbortController()
    const task: LocalAgentTaskState = {
      ...createTaskStateBase(taskId, 'local_agent', 'Implement layout export', 'toolu_agent'),
      status: 'running',
      agentId: taskId,
      prompt: 'Implement layout export',
      agentType: 'general-purpose',
      abortController,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    let appState = {
      tasks: { [taskId]: task },
      toolPermissionContext: getEmptyToolPermissionContext(),
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'I am planning the layout export.' }],
    }) as Message

    async function* makeStream(): AsyncGenerator<Message, void> {
      yield message
    }

    await runAsyncAgentLifecycle({
      taskId,
      abortController,
      makeStream,
      metadata: {
        prompt: 'Implement layout export',
        resolvedAgentModel: 'test-model',
        isBuiltInAgent: true,
        startTime: Date.now(),
        agentType: 'general-purpose',
        isAsync: true,
      },
      description: 'Implement layout export',
      toolUseContext: {
        options: { tools: [] },
        toolUseId: 'toolu_agent',
        getAppState: () => appState,
      } as unknown as ToolUseContext,
      rootSetAppState: setAppState,
      agentIdForCleanup: taskId,
      enableSummarization: false,
      getWorktreeResult: async () => ({}),
    })

    const progressEvent = drainSdkEvents().find(
      event => event.subtype === 'task_progress' && event.task_id === taskId,
    )
    expect(progressEvent).toBeDefined()
    expect(progressEvent).toMatchObject({
      subtype: 'task_progress',
      task_id: taskId,
      tool_use_id: 'toolu_agent',
      summary: 'Implement layout export',
    })
  })

  test('notifies the parent before post-completion cleanup finishes', async () => {
    const taskId = 'agent-notify-first'
    const abortController = new AbortController()
    const task: LocalAgentTaskState = {
      ...createTaskStateBase(taskId, 'local_agent', 'Review code', 'toolu_agent'),
      status: 'running',
      agentId: taskId,
      epoch: 1,
      prompt: 'Review code',
      agentType: 'general-purpose',
      abortController,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    let appState = {
      tasks: { [taskId]: task },
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      toolPermissionContext: getEmptyToolPermissionContext(),
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'Review complete.' }],
    }) as Message
    let cleanupStarted = false

    async function* makeStream(): AsyncGenerator<Message, void> {
      yield message
    }

    const result = await Promise.race([
      runAsyncAgentLifecycle({
        taskId,
        abortController,
        makeStream,
        metadata: {
          prompt: 'Review code',
          resolvedAgentModel: 'test-model',
          isBuiltInAgent: true,
          startTime: Date.now(),
          agentType: 'general-purpose',
          isAsync: true,
        },
        description: 'Review code',
        toolUseContext: {
          options: { tools: [] },
          toolUseId: 'toolu_agent',
          getAppState: () => appState,
        } as unknown as ToolUseContext,
        rootSetAppState: setAppState,
        agentIdForCleanup: taskId,
        enableSummarization: false,
        getWorktreeResult: () => {
          cleanupStarted = true
          return new Promise(() => {})
        },
      }).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
    ])

    expect(result).toBe('completed')
    expect(cleanupStarted).toBe(true)
    expect(appState.tasks[taskId]?.status).toBe('completed')
    expect(getCommandQueue()).toHaveLength(0)
    drainAgentCompletionInbox(setAppState)
    expect(getCommandQueue()).toHaveLength(1)
    expect(String(getCommandQueue()[0]?.value)).toContain(
      '<status>completed</status>',
    )
    expect(String(getCommandQueue()[0]?.value)).toContain(
      '<task-type>local_agent</task-type>',
    )
    expect(String(getCommandQueue()[0]?.value)).toContain('Review complete.')
  })

  test('streams a background agent\'s tool activity tagged with the parent tool_use id', async () => {
    const emitSpy = spyOn(sdkEventQueue, 'emitAgentToolActivity').mockImplementation(
      () => {},
    )
    try {
      const taskId = 'agent-activity'
      const abortController = new AbortController()
      const task: LocalAgentTaskState = {
        ...createTaskStateBase(taskId, 'local_agent', 'Probe', 'toolu_parent'),
        status: 'running',
        agentId: taskId,
        prompt: 'Probe',
        agentType: 'general-purpose',
        abortController,
        retrieved: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
        isBackgrounded: true,
        pendingMessages: [],
        retain: false,
        diskLoaded: false,
      }
      let appState = {
        tasks: { [taskId]: task },
        toolPermissionContext: getEmptyToolPermissionContext(),
        speculation: IDLE_SPECULATION_STATE,
      } as unknown as AppState
      const setAppState = (updater: (prev: AppState) => AppState): void => {
        appState = updater(appState)
      }
      const toolUseMsg = createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'ls' } },
        ],
      }) as Message
      const toolResultMsg = createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_child', content: 'files', is_error: false },
        ],
      }) as Message
      async function* makeStream(): AsyncGenerator<Message, void> {
        yield toolUseMsg
        yield toolResultMsg
      }

      await Promise.race([
        runAsyncAgentLifecycle({
          taskId,
          abortController,
          makeStream,
          metadata: {
            prompt: 'Probe',
            resolvedAgentModel: 'test-model',
            isBuiltInAgent: true,
            startTime: Date.now(),
            agentType: 'general-purpose',
            isAsync: true,
          },
          description: 'Probe',
          toolUseContext: {
            options: { tools: [] },
            toolUseId: 'toolu_parent',
            getAppState: () => appState,
          } as unknown as ToolUseContext,
          rootSetAppState: setAppState,
          agentIdForCleanup: taskId,
          enableSummarization: false,
          getWorktreeResult: () => new Promise(() => {}),
        }).then(() => 'completed'),
        new Promise(resolve => setTimeout(() => resolve('timed-out'), 50)),
      ])

      expect(emitSpy.mock.calls).toContainEqual([
        taskId,
        'toolu_parent',
        { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'toolu_child', input: { command: 'ls' } },
      ])
      expect(emitSpy.mock.calls).toContainEqual([
        taskId,
        'toolu_parent',
        { kind: 'tool_result', tool_use_id: 'toolu_child', content: 'files', is_error: false },
      ])
    } finally {
      emitSpy.mockRestore()
    }
  })
})

describe('extractAgentToolActivities', () => {
  test('extracts tool_use blocks from an assistant message', () => {
    const message = createAssistantMessage({
      content: [
        { type: 'text', text: 'Running a command' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'ls' } },
    ])
  })

  test('skips the internal StructuredOutput tool', () => {
    const message = createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: SYNTHETIC_OUTPUT_TOOL_NAME, input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/a' } },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'toolu_2', input: { file_path: '/a' } },
    ])
  })

  test('extracts tool_result blocks from a user message', () => {
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'output', is_error: false },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_result', tool_use_id: 'toolu_1', content: 'output', is_error: false },
    ])
  })

  test('marks errored tool_result blocks', () => {
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
      ],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([
      { kind: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
    ])
  })

  test('returns empty for string-only user content', () => {
    const message = createUserMessage({ content: 'just text' }) as Message
    expect(extractAgentToolActivities(message)).toEqual([])
  })

  test('returns empty for an assistant message with no tool_use', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'no tools here' }],
    }) as Message
    expect(extractAgentToolActivities(message)).toEqual([])
  })
})

describe('emitAgentToolActivitiesForMessage', () => {
  test('emits child tool activity for backgrounded sync agents', () => {
    const emitSpy = spyOn(sdkEventQueue, 'emitAgentToolActivity').mockImplementation(
      () => {},
    )
    try {
      const message = createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'pwd' } },
        ],
      }) as Message

      emitAgentToolActivitiesForMessage(message, 'agent-foregrounded', 'toolu_parent')

      expect(emitSpy.mock.calls).toEqual([
        [
          'agent-foregrounded',
          'toolu_parent',
          { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'toolu_child', input: { command: 'pwd' } },
        ],
      ])
    } finally {
      emitSpy.mockRestore()
    }
  })

  test('does nothing without a parent tool use id', () => {
    const emitSpy = spyOn(sdkEventQueue, 'emitAgentToolActivity').mockImplementation(
      () => {},
    )
    try {
      const message = createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'pwd' } },
        ],
      }) as Message

      emitAgentToolActivitiesForMessage(message, 'agent-foregrounded', undefined)

      expect(emitSpy).not.toHaveBeenCalled()
    } finally {
      emitSpy.mockRestore()
    }
  })
})
