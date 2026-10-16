import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { isSlashCommand } from '../messageQueueManager.js'

/**
 * Regression: the desktop/H5 composer sends prompt content as a
 * ContentBlockParam[] (see conversationService.buildUserContent ->
 * print.ts enqueue). The mid-turn drain filter in query.ts consults this
 * predicate to keep slash commands OUT of the queued_command attachment
 * path — with a string-only check it returned false for block arrays, so a
 * mid-turn "/compact" (context panel button) was delivered to the model as
 * text ("The user sent a new message while you were working: /compact")
 * and consumed from the queue, never reaching processSlashCommand.
 */
function cmd(
  value: QueuedCommand['value'],
  overrides: Partial<QueuedCommand> = {},
): QueuedCommand {
  return { value, mode: 'prompt', ...overrides }
}

const text = (t: string): ContentBlockParam => ({ type: 'text', text: t })
const image: ContentBlockParam = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
}

describe('isSlashCommand', () => {
  test('string values: leading slash routes to processSlashCommand', () => {
    expect(isSlashCommand(cmd('/compact'))).toBe(true)
    expect(isSlashCommand(cmd('  /context now'))).toBe(true)
    expect(isSlashCommand(cmd('plain text'))).toBe(false)
    expect(isSlashCommand(cmd('not /at the start'))).toBe(false)
  })

  test('skipSlashCommands overrides string detection (bridge/CCR text)', () => {
    expect(isSlashCommand(cmd('/compact', { skipSlashCommands: true }))).toBe(false)
  })

  test('block arrays: last text block decides, matching the turn parser', () => {
    // The exact desktop shape for "/compact": one text block.
    expect(isSlashCommand(cmd([text('/compact')]))).toBe(true)
    // With preceding image blocks (composer sends image blocks first).
    expect(isSlashCommand(cmd([image, text('/compact')]))).toBe(true)
    // Trailing image block: processUserInput/QueryEngine would not read the
    // text as the command input, so neither should the routing decision.
    expect(isSlashCommand(cmd([text('/compact'), image]))).toBe(false)
  })

  test('block arrays: non-slash and empty values stay plain prompts', () => {
    expect(isSlashCommand(cmd([text('hello')]))).toBe(false)
    expect(isSlashCommand(cmd([text('  ')]))).toBe(false)
    expect(isSlashCommand(cmd([image]))).toBe(false)
    expect(isSlashCommand(cmd([]))).toBe(false)
  })

  test('block arrays honor skipSlashCommands too', () => {
    expect(
      isSlashCommand(cmd([text('/compact')], { skipSlashCommands: true })),
    ).toBe(false)
  })
})
