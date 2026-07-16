import { SHELL_TOOL_NAMES } from './shell/shellToolUtils.js'

const SHOT_COUNT_REGEX = /(\d+)-shotted by/

/** Extract the first PR-attribution shot count from assistant tool content. */
export function extractShotCountFromAssistantContent(content: unknown): number | null {
  if (!Array.isArray(content)) return null
  for (const candidate of content) {
    if (!candidate || typeof candidate !== 'object') continue
    const block = candidate as Record<string, unknown>
    if (
      block.type !== 'tool_use' ||
      typeof block.name !== 'string' ||
      !SHELL_TOOL_NAMES.includes(block.name) ||
      !block.input ||
      typeof block.input !== 'object'
    ) {
      continue
    }
    const command = (block.input as Record<string, unknown>).command
    if (typeof command !== 'string') continue
    const match = SHOT_COUNT_REGEX.exec(command)
    if (match) return Number.parseInt(match[1]!, 10)
  }
  return null
}
