import type { OpenAIResponsesReasoningItem } from './types.js'
import {
  OPENAI_REASONING_ENVELOPE_PREFIX,
  parseOpenAIReasoningEnvelope,
} from '../../../utils/openAIReasoningEnvelope.js'

type OpenAIReasoningEnvelope = {
  id?: string
  summary: OpenAIResponsesReasoningItem['summary']
  encrypted_content: string
}

export function encodeOpenAIReasoningEnvelope(
  item: OpenAIResponsesReasoningItem,
): string | null {
  if (!item.encrypted_content) return null

  return `${OPENAI_REASONING_ENVELOPE_PREFIX}${JSON.stringify({
    ...(item.id ? { id: item.id } : {}),
    summary: item.summary ?? [],
    encrypted_content: item.encrypted_content,
  } satisfies OpenAIReasoningEnvelope)}`
}

export function decodeOpenAIReasoningEnvelope(
  data: string,
): OpenAIResponsesReasoningItem | null {
  const envelope = parseOpenAIReasoningEnvelope(data)
  if (!envelope) return null

  return {
    type: 'reasoning',
    ...(envelope.id ? { id: envelope.id } : {}),
    summary: envelope.summary,
    encrypted_content: envelope.encryptedContent,
  }
}
