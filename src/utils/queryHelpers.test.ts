import { describe, expect, test } from 'bun:test'
import {
  createUserInterruptionMessage,
  createUserMessage,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from './messages.js'
import { isResultSuccessful } from './queryHelpers.js'

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
