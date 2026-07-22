import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getSessionId, setIsInteractive, switchSession } from '../../bootstrap/state.js'
import * as sdkEventQueue from '../../utils/sdkEventQueue.js'
import type { AppState } from '../../state/AppState.js'
import { IDLE_SPECULATION_STATE } from '../../state/AppStateStore.js'
import { createTaskStateBase } from '../../Task.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { SessionId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  drainSdkEvents,
} from '../../utils/sdkEventQueue.js'
import { getQueuedCommandAttachments } from '../../utils/attachments.js'
import {
  dequeue,
  clearCommandQueue,
  dequeueAllMatching,
  enqueue,
  getCommandQueue,
  popAllEditable,
  remove,
  removeByFilter,
  resetCommandQueue,
} from '../../utils/messageQueueManager.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { flushAgentCompletionsAndProcessQueueIfReady, processQueueIfReady } from '../../utils/queueProcessor.js'
import { parseTaskNotificationXml } from '../../utils/taskNotificationPolicy.js'
import {
  createAgentStallTransitionHandler,
  emitAgentToolActivitiesForMessage,
  extractAgentToolActivities,
  quiesceLocalAgentLifecycles,
  runAsyncAgentLifecycle,
} from './agentToolUtils.js'
import {
  applyAgentStallStatus,
  completeAgentTask,
  ackAgentCompletionCommands,
  drainAgentCompletionInbox,
  enqueueAgentNotification,
  failAgentTask,
  flushAndDrainAgentCompletionInbox,
  subscribeToAgentCompletionWake,
  killAsyncAgent,
  loadAgentRuntimeSnapshot,
  reconcileAgentCompletionInbox,
  requeueAgentCompletionCommands,
  persistAgentRuntimeSnapshot,
  registerAsyncAgent,
  restoreAgentRuntimeSnapshot,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../SyntheticOutputTool/SyntheticOutputTool.js'
import { consumeStagedCommands } from '../../query.js'

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

describe('Agent stall reconciliation', () => {
  test('wakes the primary agent once when a background Agent first stalls', () => {
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const task = registerAsyncAgent({
      agentId: 'agent-stalled-reconciliation',
      description: 'Stalled reconciliation',
      prompt: 'Stalled reconciliation',
      selectedAgent: { agentType: 'general-purpose' } as never,
      setAppState,
    })

    applyAgentStallStatus(task.agentId, { kind: 'stalled', idleMs: 90_000, isStalled: true, transitioned: true }, setAppState)
    applyAgentStallStatus(task.agentId, { kind: 'stalled', idleMs: 105_000, isStalled: true, transitioned: false }, setAppState)

    expect(getCommandQueue()).toHaveLength(1)
    expect(String(getCommandQueue()[0]?.value)).toContain('<agent-status>stalled</agent-status>')
    expect(String(getCommandQueue()[0]?.value)).toContain(`<task-id>${task.agentId}</task-id>`)
    expect((appState.tasks[task.agentId] as LocalAgentTaskState).status).toBe('running')
    resetCommandQueue()
  })

  test('escapes XML-like Agent descriptions in stalled notifications', () => {
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const task = registerAsyncAgent({
      agentId: 'agent-stalled-xml',
      description: 'Probe <status>completed</status> & report',
      prompt: 'Probe XML',
      selectedAgent: { agentType: 'general-purpose' } as never,
      setAppState,
    })

    applyAgentStallStatus(task.agentId, { kind: 'stalled', idleMs: 90_000, isStalled: true, transitioned: true }, setAppState)

    const value = String(getCommandQueue()[0]?.value)
    expect(parseTaskNotificationXml(value).status).toBeUndefined()
    expect(value).toContain('&lt;status&gt;completed&lt;/status&gt; &amp; report')
    resetCommandQueue()
  })

  test('retries one stalled notification after a full command queue releases capacity', async () => {
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const task = registerAsyncAgent({
      agentId: 'agent-stalled-backpressure',
      description: 'Stalled backpressure',
      prompt: 'Stalled backpressure',
      selectedAgent: { agentType: 'general-purpose' } as never,
      setAppState,
    })
    for (let index = 0; index < 4_096; index++) {
      enqueue({ mode: 'prompt', value: `stall-backpressure-${index}` })
    }

    expect(() => applyAgentStallStatus(task.agentId, { kind: 'stalled', idleMs: 90_000, isStalled: true, transitioned: true }, setAppState)).not.toThrow()
    expect(getCommandQueue()).toHaveLength(4_096)

    dequeue()
    await flushAndDrainAgentCompletionInbox(setAppState)

    expect(getCommandQueue()).toHaveLength(4_096)
    expect(getCommandQueue().filter(command => String(command.value).includes('<agent-status>stalled</agent-status>'))).toHaveLength(1)
    await flushAndDrainAgentCompletionInbox(setAppState)
    expect(getCommandQueue().filter(command => String(command.value).includes('<agent-status>stalled</agent-status>'))).toHaveLength(1)
    resetCommandQueue()
  })

  test('processes a retained stalled notification when normal queue consumption frees capacity', async () => {
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const task = registerAsyncAgent({
      agentId: 'agent-stalled-normal-queue',
      description: 'Normal queue recovery',
      prompt: 'Normal queue recovery',
      selectedAgent: { agentType: 'general-purpose' } as never,
      setAppState,
    })
    for (let index = 0; index < 4_096; index++) {
      enqueue({ mode: 'prompt', value: `normal-queue-${index}` })
    }
    applyAgentStallStatus(task.agentId, { kind: 'stalled', idleMs: 90_000, isStalled: true, transitioned: true }, setAppState)
    dequeue()
    const processed: string[] = []

    const result = await flushAgentCompletionsAndProcessQueueIfReady({
      setAppState,
      getAppState: () => appState,
      executeInput: async commands => {
        processed.push(...commands.map(command => String(command.value)))
      },
    })

    expect(result.processed).toBe(true)
    expect(processed).toHaveLength(4_095)
    expect(getCommandQueue().filter(command => String(command.value).includes('<agent-status>stalled</agent-status>'))).toHaveLength(1)
    resetCommandQueue()
  })

  test('clears a retained stalled notification on every terminal transition', () => {
    for (const terminal of ['completed', 'failed', 'killed'] as const) {
      let appState = {
        tasks: {},
        agentCompletionInbox: [],
        nextAgentCompletionSequence: 1,
        speculation: IDLE_SPECULATION_STATE,
      } as unknown as AppState
      const setAppState = (updater: (prev: AppState) => AppState): void => {
        appState = updater(appState)
      }
      const task = registerAsyncAgent({
        agentId: `agent-stalled-terminal-${terminal}`,
        description: terminal,
        prompt: terminal,
        selectedAgent: { agentType: 'general-purpose' } as never,
        setAppState,
      })
      setAppState(prev => ({
        ...prev,
        tasks: {
          ...prev.tasks,
          [task.agentId]: {
            ...(prev.tasks[task.agentId] as LocalAgentTaskState),
            stalledSinceMs: 90_000,
            pendingStallNotification: {
              sessionId: getSessionId(),
              epoch: task.epoch,
              notification: '<task-notification>stalled</task-notification>',
            },
          },
        },
      }))
      if (terminal === 'completed') {
        completeAgentTask({ agentId: task.agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
      } else if (terminal === 'failed') {
        failAgentTask(task.agentId, 'failed', setAppState, task.epoch)
      } else {
        killAsyncAgent(task.agentId, setAppState, task.epoch)
      }
      const terminalTask = appState.tasks[task.agentId] as LocalAgentTaskState
      expect(terminalTask.pendingStallNotification).toBeUndefined()
      expect(terminalTask.stalledSinceMs).toBeUndefined()
      resetCommandQueue()
    }
  })

  test('drops a queued stalled notification after the Agent resumes at a newer epoch', () => {
    const sessionId = '45454545-4545-4454-8454-454545454545' as SessionId
    switchSession(sessionId)
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
      agentId: 'agent-stalled-old-epoch',
      description: 'Old epoch',
      prompt: 'Old epoch',
      selectedAgent,
      setAppState,
    })
    applyAgentStallStatus(first.agentId, { kind: 'stalled', idleMs: 90_000, isStalled: true, transitioned: true }, setAppState)
    killAsyncAgent(first.agentId, setAppState, first.epoch)
    const second = registerAsyncAgent({
      agentId: first.agentId,
      description: 'New epoch',
      prompt: 'New epoch',
      selectedAgent,
      setAppState,
    })

    expect(second.epoch).toBe(first.epoch + 1)
    expect(getCommandQueue()).toEqual([])
    resetCommandQueue()
  })

  test('scopes a watchdog transition to the Agent session and epoch', () => {
    const sessionA = '56565656-5656-4565-8565-565656565656' as SessionId
    const sessionB = '67676767-6767-4676-8676-676767676767' as SessionId
    switchSession(sessionA)
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const task = registerAsyncAgent({
      agentId: 'agent-stalled-session-scope',
      description: 'Session scope',
      prompt: 'Session scope',
      selectedAgent: { agentType: 'general-purpose' } as never,
      setAppState,
    })
    const onStallTransition = createAgentStallTransitionHandler(
      sessionA,
      task.agentId,
      task.epoch,
      setAppState,
    )

    switchSession(sessionB)
    onStallTransition({ kind: 'stalled', idleMs: 90_000, isStalled: true, transitioned: true })

    expect((appState.tasks[task.agentId] as LocalAgentTaskState).stalledSinceMs).toBeUndefined()
    expect(getCommandQueue()).toEqual([])
  })
})

describe('Agent runtime recovery', () => {
  test('preserves notified state so only backpressured terminal tasks retry after restore', () => {
    const restored = restoreAgentRuntimeSnapshot({
      version: 1,
      nextSequence: 1,
      tasks: [{
        id: 'agent-already-notified',
        epoch: 1,
        status: 'completed',
        description: 'Already notified',
        prompt: 'Already notified',
        agentType: 'general-purpose',
        startTime: 1,
        notified: true,
      }, {
        id: 'agent-backpressured',
        epoch: 1,
        status: 'failed',
        description: 'Backpressured',
        prompt: 'Backpressured',
        agentType: 'general-purpose',
        startTime: 2,
        error: 'queue full',
        notified: false,
      }],
      inbox: [],
    })

    expect((restored.tasks['agent-already-notified'] as LocalAgentTaskState).notified).toBe(true)
    expect((restored.tasks['agent-backpressured'] as LocalAgentTaskState).notified).toBe(false)
  })
  test('preserves a full persisted inbox instead of replacing completions with interrupted notices', () => {
    const persistedInbox = Array.from({ length: 64 }, (_, index) => ({
      version: 1 as const,
      sequence: index + 1,
      taskId: `agent-existing-${index}`,
      epoch: 1,
      notification: `<task-notification>existing-${index}</task-notification>`,
    }))
    const restored = restoreAgentRuntimeSnapshot({
      version: 1,
      nextSequence: 65,
      tasks: Array.from({ length: 3 }, (_, index) => ({
        id: `agent-running-${index}`,
        epoch: 1,
        status: 'running',
        description: `Running ${index}`,
        prompt: `Running ${index}`,
        agentType: 'general-purpose',
        startTime: index + 1,
      })),
      inbox: persistedInbox,
    })

    expect(restored.agentCompletionInbox).toHaveLength(64)
    expect(restored.agentCompletionInbox.map(item => item.taskId)).toEqual(
      persistedInbox.map(item => item.taskId),
    )
    expect(Object.values(restored.tasks).map(task => task.status)).toEqual([
      'failed',
      'failed',
      'failed',
    ])
  })

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

  test('keeps the previous snapshot when an oversized unconsumed inbox cannot be compacted', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-oversized-'))
    const filePath = path.join(directory, 'runtime.json')
    try {
      const previous = '{"version":1,"nextSequence":1,"tasks":[],"inbox":[]}'
      await fs.writeFile(filePath, previous, 'utf8')
      const oversizedInbox = Array.from({ length: 5_000 }, (_, index) => ({
        version: 1 as const,
        sequence: index + 1,
        taskId: `agent-oversized-${index}-${'x'.repeat(500)}`,
        epoch: 1,
        notification: `${index}-completion`,
        delivery: 'pending' as const,
      }))

      await expect(persistAgentRuntimeSnapshot(filePath, {
        tasks: {},
        agentCompletionInbox: oversizedInbox,
        nextAgentCompletionSequence: 5_001,
      })).rejects.toThrow('exceeds 2000000 bytes')
      expect(await fs.readFile(filePath, 'utf8')).toBe(previous)
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
  afterEach(() => resetCommandQueue())

  test.each(['completed', 'failed', 'killed'] as const)(
    'preserves an unnotified %s task under full queue backpressure until its completion is delivered once',
    async status => {
      const blockedTaskId = `agent-registry-blocked-${status}`
      let appState = {
        tasks: {},
        agentCompletionInbox: Array.from({ length: 64 }, (_, index) => ({
          version: 1 as const,
          sequence: index + 1,
          taskId: `agent-registry-inbox-${index}`,
          epoch: 1,
          notification: `<task-notification>registry-${index}</task-notification>`,
        })),
        nextAgentCompletionSequence: 65,
        speculation: IDLE_SPECULATION_STATE,
      } as unknown as AppState
      const setAppState = (updater: (prev: AppState) => AppState): void => {
        appState = updater(appState)
      }
      const selectedAgent = { agentType: 'general-purpose' } as never
      for (let index = 0; index < 64; index++) {
        const agentId = index === 0 ? blockedTaskId : `agent-registry-running-${index}`
        const task = registerAsyncAgent({ agentId, description: agentId, prompt: agentId, selectedAgent, setAppState })
        if (index === 0) {
          if (status === 'completed') {
            completeAgentTask({ agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
          } else if (status === 'failed') {
            failAgentTask(agentId, 'registry failure', setAppState, task.epoch)
          } else {
            killAsyncAgent(agentId, setAppState, task.epoch)
          }
        }
      }
      for (let index = 0; index < 4_096; index++) {
        enqueue({ mode: 'prompt', value: `registry-user-${index}` })
      }

      expect(enqueueAgentNotification({
        taskId: blockedTaskId,
        description: blockedTaskId,
        status,
        error: status === 'failed' ? 'registry failure' : undefined,
        setAppState,
        epoch: 1,
      })).toBe(false)
      expect(() => registerAsyncAgent({
        agentId: 'agent-registry-rejected',
        description: 'rejected',
        prompt: 'rejected',
        selectedAgent,
        setAppState,
      })).toThrow('running, retained, or awaiting completion delivery')
      expect(appState.tasks[blockedTaskId]?.status).toBe(status)
      expect((appState.tasks[blockedTaskId] as LocalAgentTaskState).notified).toBe(false)
      expect(appState.tasks['agent-registry-rejected']).toBeUndefined()
      expect(Object.values(appState.tasks).filter(task => task.type === 'local_agent')).toHaveLength(64)

      for (let index = 0; index < 64; index++) dequeue()
      await flushAndDrainAgentCompletionInbox(setAppState)
      expect((appState.tasks[blockedTaskId] as LocalAgentTaskState).notified).toBe(false)
      expect(appState.agentCompletionInbox).toHaveLength(64)

      const removed = dequeueAllMatching(command => command.agentCompletion !== undefined)
      ackAgentCompletionCommands(setAppState, removed)
      await flushAndDrainAgentCompletionInbox(setAppState)
      expect((appState.tasks[blockedTaskId] as LocalAgentTaskState).notified).toBe(true)
      expect(appState.agentCompletionInbox.at(-1)?.taskId).toBe(blockedTaskId)
      expect(appState.agentCompletionInbox).toHaveLength(1)
      expect(getCommandQueue().filter(command => command.agentCompletion?.taskId === blockedTaskId)).toHaveLength(1)
    },
  )

  test('rejects registration when all registry slots are running or retained without changing existing state', () => {
    let appState = { tasks: {} } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const selectedAgent = { agentType: 'general-purpose' } as never
    for (let index = 0; index < 64; index++) {
      const agentId = `agent-registry-protected-${index}`
      registerAsyncAgent({ agentId, description: agentId, prompt: agentId, selectedAgent, setAppState })
      if (index % 2 === 1) {
        setAppState(prev => ({
          ...prev,
          tasks: {
            ...prev.tasks,
            [agentId]: {
              ...(prev.tasks[agentId] as LocalAgentTaskState),
              retain: true,
            },
          },
        }))
      }
    }
    const tasksBefore = appState.tasks

    expect(() => registerAsyncAgent({
      agentId: 'agent-registry-all-protected',
      description: 'all protected',
      prompt: 'all protected',
      selectedAgent,
      setAppState,
    })).toThrow('running, retained, or awaiting completion delivery')
    expect(appState.tasks).toBe(tasksBefore)
    expect(appState.tasks['agent-registry-all-protected']).toBeUndefined()
    expect(Object.values(appState.tasks).filter(task => task.type === 'local_agent')).toHaveLength(64)
  })

  test('does not evict a terminal Agent until its queued completion is consumed', async () => {
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
    for (let index = 0; index < 64; index++) {
      const agentId = `agent-registry-queued-${String(index).padStart(2, '0')}`
      const task = registerAsyncAgent({ agentId, description: agentId, prompt: agentId, selectedAgent, setAppState })
      if (index < 63) {
        completeAgentTask({ agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
        enqueueAgentNotification({ taskId: agentId, description: agentId, status: 'completed', setAppState, epoch: task.epoch })
      }
    }

    expect(() => registerAsyncAgent({
      agentId: 'agent-registry-before-consumption',
      description: 'before consumption',
      prompt: 'before consumption',
      selectedAgent,
      setAppState,
    })).toThrow('awaiting completion delivery')
    expect(appState.tasks['agent-registry-queued-00']).toBeDefined()

    drainAgentCompletionInbox(setAppState)
    const queuedCompletions = dequeueAllMatching(command => command.agentCompletion !== undefined)
    const attachments = await getQueuedCommandAttachments(queuedCompletions, appState)
    expect(attachments).toHaveLength(63)
    ackAgentCompletionCommands(setAppState, queuedCompletions)

    registerAsyncAgent({
      agentId: 'agent-registry-after-consumption',
      description: 'after consumption',
      prompt: 'after consumption',
      selectedAgent,
      setAppState,
    })
    expect(appState.tasks['agent-registry-queued-00']).toBeUndefined()
    expect(appState.tasks['agent-registry-after-consumption']).toBeDefined()
  })

  test('evicts only the oldest consumed terminal Agent without evicting running Agents', async () => {
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
    for (let index = 0; index < 64; index++) {
      const agentId = `agent-registry-${String(index).padStart(2, '0')}`
      const task = registerAsyncAgent({ agentId, description: agentId, prompt: agentId, selectedAgent, setAppState })
      if (index < 63) {
        completeAgentTask({ agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
        enqueueAgentNotification({ taskId: agentId, description: agentId, status: 'completed', setAppState, epoch: task.epoch })
      }
    }

    drainAgentCompletionInbox(setAppState)
    const consumed = dequeueAllMatching(command => command.agentCompletion !== undefined)
    expect(await getQueuedCommandAttachments(consumed, appState)).toHaveLength(63)
    ackAgentCompletionCommands(setAppState, consumed)

    registerAsyncAgent({ agentId: 'agent-registry-new', description: 'new', prompt: 'new', selectedAgent, setAppState })

    expect(appState.tasks['agent-registry-00']).toBeUndefined()
    expect(appState.tasks['agent-registry-63']?.status).toBe('running')
    expect(appState.tasks['agent-registry-new']?.status).toBe('running')
    expect(Object.values(appState.tasks).filter(task => task.type === 'local_agent')).toHaveLength(64)
  })
})

describe('Agent completion inbox', () => {
  afterEach(() => {
    resetCommandQueue()
  })

  test('requeues only the removed completion when three completions share a timestamp', () => {
    const sessionId = getSessionId()
    const completions = ['agent-same-ms-1', 'agent-same-ms-2', 'agent-same-ms-3'].map((taskId, index) => ({
      version: 1 as const,
      sequence: index + 1,
      taskId,
      epoch: 1,
      notification: `<task-notification>${taskId}</task-notification>`,
      delivery: 'pending' as const,
    }))
    let appState = {
      tasks: Object.fromEntries(completions.map(item => [item.taskId, {
        ...createTaskStateBase(item.taskId, 'local_agent', item.taskId),
        type: 'local_agent' as const,
        status: 'completed' as const,
        agentId: item.taskId,
        epoch: 1,
        prompt: item.taskId,
        agentType: 'general-purpose',
        notified: true,
        retrieved: false,
        lastReportedToolCount: 0,
        lastReportedTokenCount: 0,
        isBackgrounded: true,
        pendingMessages: [],
        retain: false,
        diskLoaded: false,
      }])),
      agentCompletionInbox: completions,
      nextAgentCompletionSequence: 4,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }

    drainAgentCompletionInbox(setAppState, sessionId)
    const middle = getCommandQueue()[1]!
    dequeueAllMatching(command => command === middle)
    reconcileAgentCompletionInbox(setAppState, sessionId)

    expect(appState.agentCompletionInbox.map(item => [item.sequence, item.delivery])).toEqual([
      [1, 'queued'],
      [2, 'pending'],
      [3, 'queued'],
    ])
    drainAgentCompletionInbox(setAppState, sessionId)
    expect(getCommandQueue().map(command => command.agentCompletion?.sequence)).toEqual([1, 3, 2])
  })

  test('returns completion ownership when queue cleanup discards receipts', () => {
    let receiptLosses = 0
    const completion = {
      value: '<task-notification>done</task-notification>',
      mode: 'task-notification' as const,
      onAgentCompletionQueueReceiptLost: () => { receiptLosses++ },
    }

    enqueue(completion)
    expect(remove([])).toEqual([])
    expect(remove([getCommandQueue()[0]!])).toHaveLength(1)
    expect(receiptLosses).toBe(0)

    enqueue(completion)
    expect(removeByFilter(command => command.mode === 'task-notification')).toHaveLength(1)
    expect(receiptLosses).toBe(1)

    enqueue(completion)
    clearCommandQueue()
    expect(receiptLosses).toBe(2)
    clearCommandQueue()

    enqueue({ ...completion, mode: 'prompt' })
    expect(popAllEditable()).toMatchObject({ text: '<task-notification>done</task-notification>' })
    expect(receiptLosses).toBe(3)
  })

  test('rolls queued ownership back when enqueue fails after reservation', () => {
    const sessionId = getSessionId()
    let appState = {
      tasks: {},
      agentCompletionInbox: [{
        version: 1 as const,
        sequence: 1,
        taskId: 'agent-enqueue-race',
        epoch: 1,
        notification: '<task-notification>race</task-notification>',
        delivery: 'pending' as const,
      }],
      nextAgentCompletionSequence: 2,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    let saturated = false
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
      if (!saturated && appState.agentCompletionInbox[0]?.delivery === 'queued') {
        saturated = true
        for (let index = 0; index < 4_096; index++) {
          enqueue({ mode: 'prompt', value: `race-${index}` })
        }
      }
    }

    expect(() => drainAgentCompletionInbox(setAppState, sessionId)).toThrow('capacity exceeded')
    expect(appState.agentCompletionInbox[0]?.delivery).toBe('pending')
  })

  test('acks successful interactive batches and requeues rejected slash commands', async () => {
    const sessionId = getSessionId()
    const queuedItem = (sequence: number, value: string, delivery = 'queued' as const) => ({
      version: 1 as const,
      sequence,
      taskId: `agent-interactive-${sequence}`,
      epoch: 1,
      notification: value,
      delivery,
    })
    let appState = {
      tasks: {},
      agentCompletionInbox: [queuedItem(1, 'batch'), queuedItem(2, '/slash')],
      nextAgentCompletionSequence: 3,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const command = (sequence: number, value: string) => ({
      value,
      mode: 'task-notification' as const,
      agentCompletion: {
        taskId: `agent-interactive-${sequence}`,
        epoch: 1,
        sessionId,
        sequence,
      },
    })
    for (const sequence of [1, 2]) {
      registerAsyncAgent({
        agentId: `agent-interactive-${sequence}`,
        description: `Interactive completion ${sequence}`,
        prompt: `Interactive completion ${sequence}`,
        selectedAgent: { agentType: 'general-purpose' } as never,
        setAppState,
      })
    }

    enqueue(command(1, 'batch'))
    expect(processQueueIfReady({
      executeInput: async () => {},
      getAppState: () => appState,
      setAppState,
    }).processed).toBe(true)
    await Promise.resolve()
    expect(appState.agentCompletionInbox.map(item => item.sequence)).toEqual([2])

    enqueue(command(2, '/slash'))
    expect(processQueueIfReady({
      executeInput: async () => { throw new Error('consumer rejected') },
      getAppState: () => appState,
      setAppState,
    }).processed).toBe(true)
    await Promise.resolve()
    expect(appState.agentCompletionInbox[0]?.delivery).toBe('pending')
  })

  test('acks completion ownership only after staged queue removal succeeds', () => {
    const sessionId = getSessionId()
    const command = {
      mode: 'task-notification' as const,
      value: '<task-notification>complete</task-notification>',
      agentCompletion: {
        taskId: 'agent-staged-success',
        epoch: 1,
        sessionId,
        sequence: 1,
      },
    }
    let appState = {
      tasks: {},
      agentCompletionInbox: [{
        version: 1 as const,
        sequence: 1,
        taskId: command.agentCompletion.taskId,
        epoch: 1,
        notification: command.value,
        delivery: 'queued' as const,
      }],
      nextAgentCompletionSequence: 2,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    enqueue(command)
    const queuedCommand = getCommandQueue()[0]!

    consumeStagedCommands([queuedCommand], setAppState, [])

    expect(getCommandQueue()).toEqual([])
    expect(appState.agentCompletionInbox).toEqual([])
  })

  test('requeues completion ownership when staged queue removal cannot consume exactly', () => {
    const sessionId = getSessionId()
    const command = {
      mode: 'task-notification' as const,
      value: '<task-notification>missing</task-notification>',
      agentCompletion: {
        taskId: 'agent-staged-failure',
        epoch: 1,
        sessionId,
        sequence: 1,
      },
    }
    let appState = {
      tasks: {},
      agentCompletionInbox: [{
        version: 1 as const,
        sequence: 1,
        taskId: command.agentCompletion.taskId,
        epoch: 1,
        notification: command.value,
        delivery: 'queued' as const,
      }],
      nextAgentCompletionSequence: 2,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }

    expect(() => consumeStagedCommands([command], setAppState, [])).toThrow(
      'Failed to remove exact queued commands after attachment staging',
    )
    expect(appState.agentCompletionInbox[0]?.delivery).toBe('pending')
  })

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

  test('drops a drained completion when the task resumes before attachment consumption', async () => {
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
    const first = registerAsyncAgent({ agentId: 'agent-drained-resume', description: 'First', prompt: 'First', selectedAgent, setAppState })
    completeAgentTask({ agentId: first.agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, first.epoch)
    enqueueAgentNotification({ taskId: first.agentId, description: 'First', status: 'completed', setAppState, epoch: first.epoch })
    drainAgentCompletionInbox(setAppState)

    registerAsyncAgent({ agentId: first.agentId, description: 'Second', prompt: 'Second', selectedAgent, setAppState })

    expect(await getQueuedCommandAttachments(getCommandQueue(), appState)).toEqual([])
  })

  test('drops a drained completion after switching sessions before attachment consumption', async () => {
    const sessionA = '12121212-1212-4212-8212-121212121212' as SessionId
    const sessionB = '34343434-3434-4434-8434-343434343434' as SessionId
    switchSession(sessionA)
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const task = registerAsyncAgent({ agentId: 'agent-drained-switch', description: 'A', prompt: 'A', selectedAgent: { agentType: 'general-purpose' } as never, setAppState })
    completeAgentTask({ agentId: task.agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
    enqueueAgentNotification({ taskId: task.agentId, description: 'A', status: 'completed', setAppState, epoch: task.epoch })
    drainAgentCompletionInbox(setAppState)

    switchSession(sessionB)

    expect(await getQueuedCommandAttachments(getCommandQueue(), appState)).toEqual([])
  })

  test('wakes REPL after a completion arrives after the main turn and drains exactly once', async () => {
    let appState = {
      tasks: {},
      agentCompletionInbox: [],
      nextAgentCompletionSequence: 1,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const task = registerAsyncAgent({
      agentId: 'agent-post-turn-repl',
      description: 'Post-turn REPL',
      prompt: 'Post-turn REPL',
      selectedAgent: { agentType: 'general-purpose' } as never,
      setAppState,
    })
    const wakes: string[] = []
    const unsubscribe = subscribeToAgentCompletionWake(async sessionId => {
      wakes.push(sessionId)
      await flushAndDrainAgentCompletionInbox(setAppState, sessionId)
    })

    try {
      completeAgentTask({ agentId: task.agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
      enqueueAgentNotification({ taskId: task.agentId, description: task.description, status: 'completed', setAppState, epoch: task.epoch })
      for (let attempt = 0; attempt < 50 && appState.agentCompletionInbox.length > 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      expect(wakes).toHaveLength(1)
      expect(appState.agentCompletionInbox.map(item => item.delivery)).toEqual(['queued'])
      expect(getCommandQueue()).toHaveLength(1)
      await flushAndDrainAgentCompletionInbox(setAppState)
      expect(getCommandQueue()).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  })

  test('does not report or mark a completion enqueued while both queues are at capacity', () => {
    const restoredItems = Array.from({ length: 64 }, (_, index) => ({
      version: 1 as const,
      sequence: index + 1,
      taskId: `agent-capacity-existing-${index}`,
      epoch: 1,
      notification: `<task-notification>existing-${index}</task-notification>`,
    }))
    const taskId = 'agent-capacity-blocked'
    const task = {
      ...createTaskStateBase(taskId, 'local_agent', 'Capacity blocked'),
      type: 'local_agent' as const,
      status: 'completed' as const,
      agentId: taskId,
      epoch: 1,
      prompt: 'Capacity blocked',
      agentType: 'general-purpose',
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
      agentCompletionInbox: restoredItems,
      nextAgentCompletionSequence: 65,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    for (let index = 0; index < 4_096; index++) {
      enqueue({ mode: 'prompt', value: `user-${index}` })
    }

    const enqueued = enqueueAgentNotification({
      taskId,
      description: task.description,
      status: 'completed',
      setAppState,
      epoch: task.epoch,
    })

    expect(enqueued).toBe(false)
    expect((appState.tasks[taskId] as LocalAgentTaskState).notified).not.toBe(true)
    expect(appState.agentCompletionInbox).toEqual(restoredItems)
    expect(getCommandQueue()).toHaveLength(4_096)
  })

  test('wakes one continuation after a fully saturated queue releases capacity', async () => {
    const restoredItems = Array.from({ length: 64 }, (_, index) => ({
      version: 1 as const,
      sequence: index + 1,
      taskId: `agent-saturated-existing-${index}`,
      epoch: 1,
      notification: `<task-notification>saturated-${index}</task-notification>`,
    }))
    const taskId = 'agent-saturated-blocked'
    const task = {
      ...createTaskStateBase(taskId, 'local_agent', 'Saturated blocked'),
      type: 'local_agent' as const,
      status: 'failed' as const,
      agentId: taskId,
      epoch: 1,
      prompt: 'Saturated blocked',
      agentType: 'general-purpose',
      error: 'capacity failure',
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
      agentCompletionInbox: restoredItems,
      nextAgentCompletionSequence: 65,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    for (let index = 0; index < 4_096; index++) {
      enqueue({ mode: 'prompt', value: `saturated-user-${index}` })
    }
    const wakes: string[] = []
    const unsubscribe = subscribeToAgentCompletionWake(sessionId => {
      wakes.push(sessionId)
    })

    try {
      expect(enqueueAgentNotification({
        taskId,
        description: task.description,
        status: 'failed',
        error: task.error,
        setAppState,
        epoch: task.epoch,
      })).toBe(false)
      expect(wakes).toEqual([])
      for (let index = 0; index < 64; index++) dequeue()

      expect(await flushAndDrainAgentCompletionInbox(setAppState)).toBe(true)
      expect((appState.tasks[taskId] as LocalAgentTaskState).notified).toBe(false)
      expect(wakes).toHaveLength(0)
      expect(getCommandQueue().filter(command => command.agentCompletion?.taskId === taskId)).toHaveLength(0)

      const removed = dequeueAllMatching(command => command.agentCompletion !== undefined)
      ackAgentCompletionCommands(setAppState, removed)
      expect(await flushAndDrainAgentCompletionInbox(setAppState)).toBe(true)
      expect(await flushAndDrainAgentCompletionInbox(setAppState)).toBe(false)

      expect((appState.tasks[taskId] as LocalAgentTaskState).notified).toBe(true)
      expect(wakes).toHaveLength(1)
      expect(getCommandQueue().filter(command => command.agentCompletion?.taskId === taskId)).toHaveLength(1)
      expect(getCommandQueue().filter(command => command.agentCompletion === undefined)).toHaveLength(4_032)
    } finally {
      unsubscribe()
    }
  })

  test('retries a blocked completion after command consumption without deleting user commands', async () => {
    const restoredItems = Array.from({ length: 64 }, (_, index) => ({
      version: 1 as const,
      sequence: index + 1,
      taskId: `agent-retry-existing-${index}`,
      epoch: 1,
      notification: `<task-notification>existing-${index}</task-notification>`,
    }))
    const taskId = 'agent-retry-blocked'
    const task = {
      ...createTaskStateBase(taskId, 'local_agent', 'Retry blocked'),
      type: 'local_agent' as const,
      status: 'completed' as const,
      agentId: taskId,
      epoch: 1,
      prompt: 'Retry blocked',
      agentType: 'general-purpose',
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
      agentCompletionInbox: restoredItems,
      nextAgentCompletionSequence: 65,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    for (let index = 0; index < 4_033; index++) {
      enqueue({ mode: 'prompt', value: `user-${index}` })
    }

    expect(enqueueAgentNotification({
      taskId,
      description: task.description,
      status: 'completed',
      setAppState,
      epoch: task.epoch,
    })).toBe(false)
    expect((appState.tasks[taskId] as LocalAgentTaskState).notified).toBe(false)

    expect(dequeue()?.value).toBe('user-0')
    await flushAndDrainAgentCompletionInbox(setAppState)

    expect((appState.tasks[taskId] as LocalAgentTaskState).notified).toBe(false)
    expect(appState.agentCompletionInbox).toHaveLength(64)
    expect(getCommandQueue()).toHaveLength(4_096)

    const removed = dequeueAllMatching(command => command.agentCompletion !== undefined)
    ackAgentCompletionCommands(setAppState, removed)
    await flushAndDrainAgentCompletionInbox(setAppState)

    expect((appState.tasks[taskId] as LocalAgentTaskState).notified).toBe(true)
    expect(appState.agentCompletionInbox.at(-1)?.taskId).toBe(taskId)
    expect(appState.agentCompletionInbox.at(-1)?.delivery).toBe('queued')
    expect(getCommandQueue().filter(command => command.agentCompletion?.taskId === taskId)).toHaveLength(1)
    expect(getCommandQueue().filter(command => command.agentCompletion === undefined)).toHaveLength(4_032)
  })

  test('keeps the 65th completion unnotified until persisted ownership has capacity', () => {
    const restoredItems = Array.from({ length: 64 }, (_, index) => ({
      version: 1 as const,
      sequence: index + 1,
      taskId: `agent-restored-${index}`,
      epoch: 1,
      notification: `<task-notification>${index}</task-notification>`,
    }))
    const newTaskId = 'agent-after-full-restore'
    const newTask = {
      ...createTaskStateBase(newTaskId, 'local_agent', 'New completion'),
      type: 'local_agent' as const,
      status: 'completed' as const,
      agentId: newTaskId,
      epoch: 1,
      prompt: 'New completion',
      agentType: 'general-purpose',
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    let appState = {
      tasks: {
        ...Object.fromEntries(restoredItems.map(item => [item.taskId, {
          ...newTask,
          id: item.taskId,
          agentId: item.taskId,
        }])),
        [newTaskId]: newTask,
      },
      agentCompletionInbox: restoredItems,
      nextAgentCompletionSequence: 65,
      speculation: IDLE_SPECULATION_STATE,
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }

    expect(enqueueAgentNotification({
      taskId: newTaskId,
      description: 'New completion',
      status: 'completed',
      setAppState,
      epoch: 1,
    })).toBe(false)

    expect(appState.agentCompletionInbox).toHaveLength(64)
    expect((appState.tasks[newTaskId] as LocalAgentTaskState).notified).toBe(false)
    const restored = restoreAgentRuntimeSnapshot({
      version: 1,
      nextSequence: appState.nextAgentCompletionSequence,
      tasks: [],
      inbox: appState.agentCompletionInbox,
    })
    expect(restored.agentCompletionInbox.map(item => item.sequence)).toEqual(
      restoredItems.map(item => item.sequence),
    )
  })

  test('defers ordered completion injection until a continuation boundary and consumes once', async () => {
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
    expect(await getQueuedCommandAttachments(getCommandQueue(), appState)).toHaveLength(2)
    drainAgentCompletionInbox(setAppState)
    expect(getCommandQueue()).toHaveLength(2)
  })
})

describe('Agent lifecycle completion backpressure', () => {
  afterEach(() => resetCommandQueue())

  test('quiesces a killed lifecycle without waiting for queue capacity and retries later', async () => {
    let appState = {
      tasks: {},
      agentCompletionInbox: Array.from({ length: 64 }, (_, index) => ({
        version: 1 as const,
        sequence: index + 1,
        taskId: `agent-quiesce-existing-${index}`,
        epoch: 1,
        notification: `<task-notification>quiesce-${index}</task-notification>`,
      })),
      nextAgentCompletionSequence: 65,
      speculation: IDLE_SPECULATION_STATE,
      toolPermissionContext: getEmptyToolPermissionContext(),
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState): void => {
      appState = updater(appState)
    }
    const task = registerAsyncAgent({
      agentId: 'agent-quiesce-backpressure',
      description: 'Quiesce backpressure',
      prompt: 'Quiesce backpressure',
      selectedAgent: { agentType: 'general-purpose' } as never,
      setAppState,
    })
    for (let index = 0; index < 4_096; index++) {
      enqueue({ mode: 'prompt', value: `quiesce-user-${index}` })
    }
    async function* makeStream(): AsyncGenerator<Message, void> {
      await new Promise<void>(resolve => {
        task.abortController!.signal.addEventListener('abort', resolve, { once: true })
      })
      throw new AbortError()
    }
    const lifecycle = runAsyncAgentLifecycle({
      taskId: task.agentId,
      epoch: task.epoch,
      abortController: task.abortController!,
      makeStream,
      metadata: {
        prompt: task.prompt,
        resolvedAgentModel: 'test-model',
        isBuiltInAgent: true,
        startTime: Date.now(),
        agentType: task.agentType,
        isAsync: true,
      },
      description: task.description,
      toolUseContext: {
        options: { tools: [] },
        toolUseId: 'tool-quiesce-backpressure',
        getAppState: () => appState,
      } as unknown as ToolUseContext,
      rootSetAppState: setAppState,
      agentIdForCleanup: task.agentId,
      enableSummarization: false,
      getWorktreeResult: async () => ({}),
    })

    await expect(quiesceLocalAgentLifecycles(setAppState, { timeoutMs: 100 })).resolves.toBeUndefined()
    await lifecycle
    expect((appState.tasks[task.agentId] as LocalAgentTaskState).status).toBe('killed')
    expect((appState.tasks[task.agentId] as LocalAgentTaskState).notified).toBe(false)

    for (let index = 0; index < 64; index++) dequeue()
    await flushAndDrainAgentCompletionInbox(setAppState)
    const removed = dequeueAllMatching(command => command.agentCompletion !== undefined)
    ackAgentCompletionCommands(setAppState, removed)
    await flushAndDrainAgentCompletionInbox(setAppState)

    expect(getCommandQueue().filter(command => command.agentCompletion?.taskId === task.agentId)).toHaveLength(1)
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
