export function shouldTriggerNonStreamingFallbackForEmptyStream({
  hasMessageStart,
  assistantMessageCount,
  stopReason,
}: {
  hasMessageStart: boolean
  assistantMessageCount: number
  stopReason: string | null
}): boolean {
  if (!hasMessageStart) return true
  if (assistantMessageCount > 0) return false
  return stopReason === null || stopReason === 'tool_use'
}
