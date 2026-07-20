import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import { isAgentCompletionCommand, isCurrentAgentCompletionCommand } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { flushAndDrainAgentCompletionInbox } from '../utils/queueProcessor.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { removeByFilter } from '../utils/messageQueueManager.js'
import type { Command } from '../types/command.js'

export function supportsHeadlessSlashCommand(command: Command): boolean {
  if (command.type === 'prompt') return command.disableNonInteractive !== true
  if (command.type === 'local') return command.supportsNonInteractive
  return command.supportsNonInteractive === true
}

export function filterCommandsForHeadlessMode(commands: Command[]): Command[] {
  return commands.filter(supportsHeadlessSlashCommand)
}

export function removeStaleHeadlessAgentCompletions(state: AppState): QueuedCommand[] {
  return removeByFilter(command =>
    isAgentCompletionCommand(command) &&
    !isCurrentAgentCompletionCommand(command, state),
  )
}

export async function wakeHeadlessAgentContinuation(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  runContinuation: () => void,
  sessionId = getSessionId(),
): Promise<void> {
  await flushAndDrainAgentCompletionInbox(setAppState, sessionId)
  if (sessionId === getSessionId()) runContinuation()
}
