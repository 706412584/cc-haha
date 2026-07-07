import type { OpenAIReasoningEffort } from './types.js'

export function normalizeOpenAIReasoningEffort(
  effort: unknown,
): OpenAIReasoningEffort | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high') {
    return effort
  }
  if (effort === 'max') {
    return 'high'
  }
  return undefined
}
