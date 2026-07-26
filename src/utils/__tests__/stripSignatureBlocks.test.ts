import { describe, expect, test } from 'bun:test'
import { createAssistantMessage, stripSignatureBlocks } from '../messages.js'

describe('stripSignatureBlocks', () => {
  test('removes thinking and redacted_thinking while keeping text', () => {
    const message = createAssistantMessage({
      content: [
        {
          type: 'thinking',
          thinking: 'secret chain of thought',
          signature: 'encrypted-blob-from-grok',
        },
        {
          type: 'redacted_thinking',
          data: 'wTzZ...M0ik',
        },
        {
          type: 'text',
          text: 'visible answer',
        },
      ] as any,
    })

    const stripped = stripSignatureBlocks([message])
    expect(stripped).toHaveLength(1)
    expect(stripped[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'visible answer' }],
      },
    })
  })

  test('returns the same array reference when nothing changes', () => {
    const message = createAssistantMessage({ content: 'plain text only' })
    const input = [message]
    expect(stripSignatureBlocks(input)).toBe(input)
  })
})
