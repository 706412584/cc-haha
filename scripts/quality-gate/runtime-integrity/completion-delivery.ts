import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AppState } from '../../../src/state/AppStateStore.js'
import {
  ackAgentCompletionCommands,
  drainAgentCompletionInbox,
  loadAgentRuntimeSnapshot,
  persistAgentRuntimeSnapshot,
  reconcileAgentCompletionInbox,
} from '../../../src/tasks/LocalAgentTask/LocalAgentTask.js'
import {
  dequeueAllMatching,
  getCommandQueue,
  resetCommandQueue,
} from '../../../src/utils/messageQueueManager.js'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-completion-delivery-'))
const snapshotPath = path.join(directory, 'agent-runtime.json')

try {
  const completions = ['agent-one', 'agent-two', 'agent-three'].map((taskId, index) => ({
    version: 1 as const,
    sequence: index + 1,
    taskId,
    epoch: 1,
    notification: `<task-notification>${taskId}</task-notification>`,
    delivery: 'pending' as const,
  }))
  let state = {
    tasks: {},
    agentCompletionInbox: completions,
    nextAgentCompletionSequence: 4,
  } as unknown as AppState
  const setState = (update: (previous: AppState) => AppState) => {
    state = update(state)
  }

  drainAgentCompletionInbox(setState)
  const firstQueue = getCommandQueue()
  if (firstQueue.map((command) => command.agentCompletion?.sequence).join(',') !== '1,2,3') {
    throw new Error('initial completion delivery order is incorrect')
  }

  const removedMiddle = dequeueAllMatching(
    (command) => command.agentCompletion?.sequence === 2,
  )
  if (removedMiddle.length !== 1) throw new Error('middle completion was not removed exactly once')
  reconcileAgentCompletionInbox(setState)
  if (state.agentCompletionInbox[1]?.delivery !== 'pending') {
    throw new Error('removed completion ownership was not returned to pending')
  }

  const accepted = dequeueAllMatching(
    (command) => command.agentCompletion?.sequence !== 2,
  )
  ackAgentCompletionCommands(setState, accepted)
  if (state.agentCompletionInbox.map((item) => item.sequence).join(',') !== '2') {
    throw new Error('accepted completions were not acknowledged exactly once')
  }

  await persistAgentRuntimeSnapshot(snapshotPath, state)
  const restored = await loadAgentRuntimeSnapshot(snapshotPath)
  if (
    restored.agentCompletionInbox.length !== 1 ||
    restored.agentCompletionInbox[0]?.sequence !== 2 ||
    restored.agentCompletionInbox[0]?.delivery !== 'pending'
  ) {
    throw new Error('pending completion ownership did not survive restart')
  }

  resetCommandQueue()
  state = { ...state, ...restored }
  drainAgentCompletionInbox(setState)
  const replayed = dequeueAllMatching((command) => command.agentCompletion?.sequence === 2)
  if (replayed.length !== 1) throw new Error('recovered completion was not redelivered exactly once')
  ackAgentCompletionCommands(setState, replayed)
  if (state.agentCompletionInbox.length !== 0) {
    throw new Error('recovered completion ownership was not acknowledged')
  }

  console.log(JSON.stringify({
    passed: true,
    initialSequence: [1, 2, 3],
    removedSequence: 2,
    acknowledgedBeforeRestart: accepted.map((command) => command.agentCompletion?.sequence),
    restoredSequence: restored.agentCompletionInbox[0]?.sequence,
    liveProcessDeliveryCounts: { '1': 1, '2': 1, '3': 1 },
    crashRecoverySemantics: 'at-least-once until persisted acknowledgement',
  }, null, 2))
} finally {
  resetCommandQueue()
  await fs.rm(directory, { recursive: true, force: true })
}
