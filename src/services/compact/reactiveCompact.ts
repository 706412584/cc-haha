import type { AssistantMessage, Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { isPromptTooLongMessage } from '../api/errors.js'
import {
  compactConversation,
  ERROR_MESSAGE_COMPACT_TIMEOUT,
  ERROR_MESSAGE_PROMPT_TOO_LONG,
  ERROR_MESSAGE_USER_ABORT,
  type CompactionResult,
} from './compact.js'

export type ReactiveCompactOutcome =
  | { ok: true; result: CompactionResult }
  | {
      ok: false
      reason: 'too_few_groups' | 'aborted' | 'exhausted' | 'error' | 'media_unstrippable'
    }

export function isWithheldPromptTooLong(
  message: Message | undefined,
): message is AssistantMessage {
  return message?.type === 'assistant' && isPromptTooLongMessage(message)
}

export function isWithheldMediaSizeError(_message: Message | undefined): boolean {
  return false
}

export function isReactiveCompactEnabled(): boolean {
  return true
}

export function isReactiveOnlyMode(): boolean {
  return false
}

export async function tryReactiveCompact({
  hasAttempted,
  querySource,
  aborted,
  messages,
  cacheSafeParams,
}: {
  hasAttempted: boolean
  // Kept loose at the call boundary (query.ts passes its QuerySource) but the
  // recursion guard below only compares against the two fork sources.
  querySource?: string
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  // Recursion guard, same as shouldAutoCompact (autoCompact.ts:231): the
  // compact fork (runForkedAgent, querySource='compact') runs a full query()
  // loop. If its oversized request also hits prompt-too-long, the fork's own
  // reactive-compact would spawn another compact fork, ad infinitum — each
  // layer re-serializing the whole oversized context (observed as a
  // CPU-churning, transcript-silent deadlock). Inside the fork the error
  // must surface instead so streamCompactSummary's PTL retry (head
  // truncation, compact.ts) can shrink the input.
  if (querySource === 'compact' || querySource === 'session_memory') {
    return null
  }
  if (hasAttempted || aborted) return null

  const messagesForCompact = getMessagesAfterCompactBoundary(messages)
  if (messagesForCompact.length === 0) return null

  try {
    return await compactConversation(
      messagesForCompact,
      cacheSafeParams.toolUseContext,
      {
        ...cacheSafeParams,
        forkContextMessages: messagesForCompact,
      },
      true,
      undefined,
      true,
    )
  } catch (error) {
    // Expected outcomes stay silent: user abort, the bounded timeout, and
    // the prompt-too-long handoff (which its own retry loop handles).
    if (
      !hasExactErrorMessage(error, ERROR_MESSAGE_PROMPT_TOO_LONG) &&
      !hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT) &&
      !hasExactErrorMessage(error, ERROR_MESSAGE_COMPACT_TIMEOUT)
    ) {
      logError(error)
    }
    return null
  }
}

export async function reactiveCompactOnPromptTooLong(
  _messages: Message[],
  _cacheSafeParams: CacheSafeParams,
  _options?: { customInstructions?: string; trigger?: 'manual' | 'auto' },
): Promise<ReactiveCompactOutcome> {
  return { ok: false, reason: 'error' }
}

export const createCachedMCState = undefined
export const isCachedMicrocompactEnabled = () => false
export const isModelSupportedForCacheEditing = () => false
export const getCachedMCConfig = () => undefined
export const markToolsSentToAPI = () => undefined
export const resetCachedMCState = () => undefined
export const checkProtectedNamespace = () => undefined
export const getCoordinatorUserContext = () => undefined
