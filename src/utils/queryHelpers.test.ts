import { describe, expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createUserInterruptionMessage,
  createUserMessage,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from './messages.js'
import {
  isEmptyThinkingOnlyAssistantMessage,
  isResultSuccessful,
} from './queryHelpers.js'

describe('query result classification', () => {
  test('treats explicit user interruption variants after tool_use as non-error results', () => {
    expect(isResultSuccessful(createUserInterruptionMessage({}), 'tool_use')).toBe(true)
    expect(isResultSuccessful(createUserInterruptionMessage({ toolUse: true }), 'tool_use')).toBe(true)
  })

  test('does not hide an ordinary user message left after tool_use', () => {
    expect(isResultSuccessful(createUserMessage({ content: 'continue' }), 'tool_use')).toBe(false)
  })

  test('requires the exact tool-use interruption message', () => {
    const ordinaryPrompt = createUserInterruptionMessage({ toolUse: true })
    ordinaryPrompt.message.content = [
      {
        type: 'text',
        text: `${INTERRUPT_MESSAGE_FOR_TOOL_USE} keep going`,
      },
    ]

    expect(isResultSuccessful(ordinaryPrompt, 'tool_use')).toBe(false)
  })
})

describe('isEmptyThinkingOnlyAssistantMessage', () => {
  test('detects thinking-only end_turn completions', () => {
    const message = createAssistantMessage({ content: 'x' })
    message.message.content = [
      {
        type: 'thinking',
        thinking: 'I should implement the combat service next…',
        signature: 'sig',
      },
    ]
    message.message.stop_reason = 'end_turn'

    expect(isEmptyThinkingOnlyAssistantMessage(message)).toBe(true)
  })

  test('detects thinking-only when stop_reason is still null (streaming path)', () => {
    const message = createAssistantMessage({ content: 'x' })
    message.message.content = [
      {
        type: 'thinking',
        thinking: 'partial thought cut mid-sentence Poison DO',
        signature: 'sig',
      },
    ]
    message.message.stop_reason = null

    expect(isEmptyThinkingOnlyAssistantMessage(message)).toBe(true)
  })

  test('rejects assistant messages that also have text or tools', () => {
    const withText = createAssistantMessage({ content: 'done' })
    withText.message.content = [
      {
        type: 'thinking',
        thinking: 'plan',
        signature: 'sig',
      },
      { type: 'text', text: 'Implementing now.' },
    ]
    withText.message.stop_reason = 'end_turn'

    const withTool = createAssistantMessage({ content: 'x' })
    withTool.message.content = [
      {
        type: 'thinking',
        thinking: 'plan',
        signature: 'sig',
      },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: { file_path: 'a.ts' },
      },
    ]
    withTool.message.stop_reason = 'tool_use'

    expect(isEmptyThinkingOnlyAssistantMessage(withText)).toBe(false)
    expect(isEmptyThinkingOnlyAssistantMessage(withTool)).toBe(false)
  })
})
