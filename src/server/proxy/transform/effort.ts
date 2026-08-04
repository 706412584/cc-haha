import type { OpenAIReasoningEffort } from './types.js'

export function normalizeOpenAIReasoningEffort(
  effort: unknown,
): OpenAIReasoningEffort | undefined {
  if (
    effort === 'none' ||
    effort === 'minimal' ||
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh' ||
    effort === 'max'
  ) {
    return effort
  }
  return undefined
}
