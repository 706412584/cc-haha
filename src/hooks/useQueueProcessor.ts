import { useEffect, useSyncExternalStore } from 'react'
import { useAppStateStore } from '../state/AppState.js'
import { hasPendingAgentStallNotification } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'
import type { QueryGuard } from '../utils/QueryGuard.js'
import { flushAgentCompletionsAndProcessQueueIfReady, processQueueIfReady } from '../utils/queueProcessor.js'

type UseQueueProcessorParams = {
  executeQueuedInput: (commands: QueuedCommand[]) => Promise<void>
  hasActiveLocalJsxUI: boolean
  queryGuard: QueryGuard
}

/**
 * Hook that processes queued commands when conditions are met.
 *
 * Uses a single unified command queue (module-level store). Priority determines
 * processing order: 'now' > 'next' (user input) > 'later' (task notifications).
 * The dequeue() function handles priority ordering automatically.
 *
 * Processing triggers when:
 * - No query active (queryGuard — reactive via useSyncExternalStore)
 * - Queue has items
 * - No active local JSX UI blocking input
 */
export function useQueueProcessor({
  executeQueuedInput,
  hasActiveLocalJsxUI,
  queryGuard,
}: UseQueueProcessorParams): void {
  // Subscribe to the query guard. Re-renders when a query starts or ends
  // (or when reserve/cancelReservation transitions dispatching state).
  const isQueryActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  )

  // Subscribe to the unified command queue via useSyncExternalStore.
  // This guarantees re-render when the store changes, bypassing
  // React context propagation delays that cause missed notifications in Ink.
  const queueSnapshot = useSyncExternalStore(
    subscribeToCommandQueue,
    getCommandQueueSnapshot,
  )
  const appStateStore = useAppStateStore()
  const pendingAgentNotifications = useSyncExternalStore(
    appStateStore.subscribe,
    () => {
      const state = appStateStore.getState()
      return state.agentCompletionInbox.length + Number(hasPendingAgentStallNotification(state))
    },
  )

  useEffect(() => {
    if (isQueryActive) return
    if (hasActiveLocalJsxUI) return

    const state = appStateStore.getState()
    if (
      state.agentCompletionInbox.length > 0 ||
      hasPendingAgentStallNotification(state)
    ) {
      void flushAgentCompletionsAndProcessQueueIfReady({
        setAppState: appStateStore.setState,
        getAppState: appStateStore.getState,
        executeInput: executeQueuedInput,
      })
      return
    }
    if (queueSnapshot.length === 0) return

    // Reservation is now owned by handlePromptSubmit (inside executeUserInput's
    // try block). The sync chain executeQueuedInput → handlePromptSubmit →
    // executeUserInput → queryGuard.reserve() runs before the first real await,
    // so by the time React re-runs this effect (due to the dequeue-triggered
    // snapshot change), isQueryActive is already true (dispatching) and the
    // guard above returns early. handlePromptSubmit's finally releases the
    // reservation via cancelReservation() (no-op if onQuery already ran end()).
    processQueueIfReady({
      executeInput: executeQueuedInput,
      getAppState: appStateStore.getState,
    })
  }, [
    queueSnapshot,
    pendingAgentNotifications,
    isQueryActive,
    executeQueuedInput,
    hasActiveLocalJsxUI,
    queryGuard,
    appStateStore,
  ])
}
