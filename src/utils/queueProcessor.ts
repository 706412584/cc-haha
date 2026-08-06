import type { AppState } from '../state/AppState.js'
import { ackAgentCompletionCommands, flushAndDrainAgentCompletionInbox, hasPendingAgentStallNotification, isCurrentAgentCompletionCommand, requeueAgentCompletionCommands } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  dequeue,
  dequeueAllMatching,
  hasCommandsInQueue,
  peek,
} from './messageQueueManager.js'

export { flushAndDrainAgentCompletionInbox }

type ProcessQueueParams = {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
  getAppState?: () => AppState
  setAppState?: (updater: (prev: AppState) => AppState) => void
}

type ProcessQueueResult = {
  processed: boolean
}

/**
 * Check if a queued command is a slash command (value starts with '/').
 */
function isSlashCommand(cmd: QueuedCommand): boolean {
  if (typeof cmd.value === 'string') {
    return cmd.value.trim().startsWith('/')
  }
  // For ContentBlockParam[], check the first text block
  for (const block of cmd.value) {
    if (block.type === 'text') {
      return block.text.trim().startsWith('/')
    }
  }
  return false
}

/**
 * Processes commands from the queue.
 *
 * Slash commands (starting with '/') and bash-mode commands are processed
 * one at a time so each goes through the executeInput path individually.
 * Bash commands need individual processing to preserve per-command error
 * isolation, exit codes, and progress UI. Other non-slash commands are
 * batched: all items **with the same mode** as the highest-priority item
 * are drained at once and passed as a single array to executeInput — each
 * becomes its own user message with its own UUID. Different modes
 * (e.g. prompt vs task-notification) are never mixed because they are
 * treated differently downstream.
 *
 * The caller is responsible for ensuring no query is currently running
 * and for calling this function again after each command completes
 * until the queue is empty.
 *
 * @returns result with processed status
 */
export function processQueueIfReady({
  executeInput,
  getAppState,
  setAppState,
}: ProcessQueueParams): ProcessQueueResult {
  // This processor runs on the REPL main thread between turns. Skip anything
  // addressed to a subagent — an unfiltered peek() returning a subagent
  // notification would set targetMode, dequeueAllMatching would find nothing
  // matching that mode with agentId===undefined, and we'd return processed:
  // false with the queue unchanged → the React effect never re-fires and any
  // queued user prompt stalls permanently.
  const appState = getAppState?.()
  // A user pause (Esc) must not be undone by a background Agent finishing.
  // queryGuard going idle means either "turn ended normally" or "user stopped
  // it", so the notification path needs this explicit latch to tell them
  // apart. Notifications stay queued (not dropped) and ride along with the
  // user's next real turn.
  const userPaused = appState?.userPausedAt !== undefined
  const isMainThread = (cmd: QueuedCommand) =>
    cmd.agentId === undefined &&
    !(userPaused && cmd.mode === 'task-notification') &&
    (appState === undefined || isCurrentAgentCompletionCommand(cmd, appState))

  const next = peek(isMainThread)
  if (!next) {
    return { processed: false }
  }

  // Slash commands and bash-mode commands are processed individually.
  // Bash commands need per-command error isolation, exit codes, and progress UI.
  if (isSlashCommand(next) || next.mode === 'bash') {
    const cmd = dequeue(isMainThread)!
    void executeInput([cmd]).then(
      () => {
        if (setAppState) ackAgentCompletionCommands(setAppState, [cmd])
      },
      () => {
        if (setAppState) requeueAgentCompletionCommands(setAppState, [cmd])
      },
    )
    return { processed: true }
  }

  // Drain all non-slash-command items with the same mode at once.
  const targetMode = next.mode
  const commands = dequeueAllMatching(
    cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) {
    return { processed: false }
  }

  void executeInput(commands).then(
    () => {
      if (setAppState) ackAgentCompletionCommands(setAppState, commands)
    },
    () => {
      if (setAppState) requeueAgentCompletionCommands(setAppState, commands)
    },
  )
  return { processed: true }
}

/**
 * Checks if the queue has pending commands.
 * Use this to determine if queue processing should be triggered.
 */
export function hasQueuedCommands(): boolean {
  return hasCommandsInQueue()
}

export async function flushAgentCompletionsAndProcessQueueIfReady({
  setAppState,
  getAppState,
  executeInput,
}: {
  setAppState: (updater: (prev: AppState) => AppState) => void
  getAppState: () => AppState
  executeInput: (commands: QueuedCommand[]) => Promise<void>
}): Promise<ProcessQueueResult> {
  const state = getAppState()
  if (
    state.agentCompletionInbox.length > 0 ||
    hasPendingAgentStallNotification(state)
  ) {
    await flushAndDrainAgentCompletionInbox(setAppState)
  }
  return processQueueIfReady({ executeInput, getAppState, setAppState })
}
