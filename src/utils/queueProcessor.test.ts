import { afterEach, describe, expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  enqueue,
  enqueuePendingNotification,
  getCommandQueue,
  resetCommandQueue,
} from './messageQueueManager.js'
import { processQueueIfReady } from './queueProcessor.js'

function makeAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    tasks: {},
    agentCompletionInbox: [],
    nextAgentCompletionSequence: 1,
    ...overrides,
  } as unknown as AppState
}

/**
 * Collects what the REPL would have sent into a new model turn. Mirrors the
 * real executeInput contract (async, resolves once the turn is dispatched).
 */
function makeExecuteInputSpy(): {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
  batches: QueuedCommand[][]
} {
  const batches: QueuedCommand[][] = []
  return {
    batches,
    executeInput: async commands => {
      batches.push(commands)
    },
  }
}

afterEach(() => {
  resetCommandQueue()
})

describe('user-paused queue processing', () => {
  test('does not start a new turn for a background Agent notification after the user pauses', () => {
    const { executeInput, batches } = makeExecuteInputSpy()
    enqueuePendingNotification({
      value: '<task-notification><task-id>agent-1</task-id></task-notification>',
      mode: 'task-notification',
    })

    const result = processQueueIfReady({
      executeInput,
      getAppState: () => makeAppState({ userPausedAt: Date.now() }),
    })

    expect(result.processed).toBe(false)
    expect(batches).toEqual([])
    // The notification must survive the pause so it reaches the model on the
    // user's next turn instead of being silently dropped.
    expect(getCommandQueue()).toHaveLength(1)
  })

  test('still processes the user own queued prompt while paused', () => {
    const { executeInput, batches } = makeExecuteInputSpy()
    enqueuePendingNotification({
      value: '<task-notification><task-id>agent-1</task-id></task-notification>',
      mode: 'task-notification',
    })
    enqueue({ mode: 'prompt', value: 'keep working on the merge' })

    const result = processQueueIfReady({
      executeInput,
      getAppState: () => makeAppState({ userPausedAt: Date.now() }),
    })

    expect(result.processed).toBe(true)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map(cmd => cmd.mode)).toEqual(['prompt'])
    expect(getCommandQueue().map(cmd => cmd.mode)).toEqual(['task-notification'])
  })

  test('delivers the retained notification once the pause is lifted', () => {
    const { executeInput, batches } = makeExecuteInputSpy()
    enqueuePendingNotification({
      value: '<task-notification><task-id>agent-1</task-id></task-notification>',
      mode: 'task-notification',
    })

    expect(
      processQueueIfReady({
        executeInput,
        getAppState: () => makeAppState({ userPausedAt: Date.now() }),
      }).processed,
    ).toBe(false)

    const resumed = processQueueIfReady({
      executeInput,
      getAppState: () => makeAppState(),
    })

    expect(resumed.processed).toBe(true)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map(cmd => cmd.mode)).toEqual(['task-notification'])
    expect(getCommandQueue()).toEqual([])
  })
})
