import { describe, expect, test } from 'bun:test'
import { createUserInterruptionMessage, createUserMessage } from './messages.js'
import { isResultSuccessful } from './queryHelpers.js'

describe('query result classification', () => {
  test('treats an explicit user interruption after tool_use as a non-error result', () => {
    expect(
      isResultSuccessful(createUserInterruptionMessage({}), 'tool_use'),
    ).toBe(true)
    expect(
      isResultSuccessful(
        createUserInterruptionMessage({ toolUse: true }),
        'tool_use',
      ),
    ).toBe(true)
  })

  test('does not hide an ordinary user message left after tool_use', () => {
    expect(
      isResultSuccessful(createUserMessage({ content: 'continue' }), 'tool_use'),
    ).toBe(false)
  })
})
