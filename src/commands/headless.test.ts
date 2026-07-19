import { afterEach, describe, expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import { IDLE_SPECULATION_STATE } from '../state/AppStateStore.js'
import type { Command } from '../types/command.js'
import { enqueue, enqueuePendingNotification, getCommandQueue, resetCommandQueue } from '../utils/messageQueueManager.js'
import { completeAgentTask, enqueueAgentNotification, registerAsyncAgent } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { filterCommandsForHeadlessMode, removeStaleHeadlessAgentCompletions, wakeHeadlessAgentContinuation } from './headless.js'

afterEach(() => resetCommandQueue())

describe('filterCommandsForHeadlessMode', () => {
  test('keeps /goal without exposing other local-jsx UI commands', () => {
    const commands = [
      {
        type: 'local-jsx',
        supportsNonInteractive: true,
        name: 'goal',
        description: 'Set a goal',
        load: async () => ({ call: async () => null }),
      },
      {
        type: 'local-jsx',
        name: 'config',
        description: 'Open config UI',
        load: async () => ({ call: async () => null }),
      },
      {
        type: 'prompt',
        name: 'review',
        description: 'Review code',
        progressMessage: 'reviewing',
        contentLength: 0,
        source: 'builtin',
        getPromptForCommand: async () => [],
      },
      {
        type: 'prompt',
        name: 'statusline',
        description: 'Hidden from print mode',
        progressMessage: 'checking',
        contentLength: 0,
        source: 'builtin',
        disableNonInteractive: true,
        getPromptForCommand: async () => [],
      },
    ] satisfies Command[]

    expect(filterCommandsForHeadlessMode(commands).map(command => command.name)).toEqual([
      'goal',
      'review',
    ])
  })
})

describe('removeStaleHeadlessAgentCompletions', () => {
  test('removes stale Agent completions while preserving non-Agent commands', () => {
    const state = {
      tasks: {},
    } as unknown as AppState
    enqueuePendingNotification({
      mode: 'task-notification',
      value: 'stale',
      agentCompletion: { taskId: 'stale', epoch: 1, sessionId: 'stale-session' },
    })
    enqueue({ mode: 'prompt', value: 'keep me' })

    expect(removeStaleHeadlessAgentCompletions(state)).toHaveLength(1)
    expect(getCommandQueue().map(command => command.value)).toEqual(['keep me'])
    expect(removeStaleHeadlessAgentCompletions(state)).toEqual([])
  })
})

describe('wakeHeadlessAgentContinuation', () => {
  test('drains a completion that arrives after the main turn before starting the continuation', async () => {
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
      agentId: 'agent-post-turn-headless',
      description: 'Post-turn headless',
      prompt: 'Post-turn headless',
      selectedAgent: { agentType: 'general-purpose' } as never,
      setAppState,
    })
    completeAgentTask({ agentId: task.agentId, content: [], totalToolUseCount: 0, totalDurationMs: 1, totalTokens: 0, usage: {} as never }, setAppState, task.epoch)
    enqueueAgentNotification({ taskId: task.agentId, description: task.description, status: 'completed', setAppState, epoch: task.epoch })
    let continuations = 0

    await wakeHeadlessAgentContinuation(setAppState, () => continuations++)

    expect(appState.agentCompletionInbox).toEqual([])
    expect(getCommandQueue()).toHaveLength(1)
    expect(continuations).toBe(1)
  })
})
