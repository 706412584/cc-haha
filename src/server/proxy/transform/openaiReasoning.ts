import type { OpenAIResponsesReasoningItem } from './types.js'

const OPENAI_REASONING_ENVELOPE_PREFIX = 'cc-haha:openai-reasoning:v1:'

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
  if (!data.startsWith(OPENAI_REASONING_ENVELOPE_PREFIX)) return null

  try {
    const value = JSON.parse(data.slice(OPENAI_REASONING_ENVELOPE_PREFIX.length)) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null

    const envelope = value as Record<string, unknown>
    if (typeof envelope.encrypted_content !== 'string' || !envelope.encrypted_content) {
      return null
    }
    if (envelope.id !== undefined && typeof envelope.id !== 'string') return null
    if (!Array.isArray(envelope.summary)) return null
    const summary = envelope.summary.filter((entry): entry is { type: string; text: string } => (
      !!entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).type === 'string' &&
      typeof (entry as Record<string, unknown>).text === 'string'
    ))
    if (summary.length !== envelope.summary.length) return null

    return {
      type: 'reasoning',
      ...(typeof envelope.id === 'string' ? { id: envelope.id } : {}),
      summary,
      encrypted_content: envelope.encrypted_content,
    }
  } catch {
    return null
  }
}
