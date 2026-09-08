import { describe, expect, test } from 'bun:test'
import { createTraceRequestSemantic } from './traceCapture.js'

describe('createTraceRequestSemantic', () => {
  test('keeps proxy request structure while replacing Computer Use image data with metadata', () => {
    const imageData = 'AQID'.repeat(4)
    const semantic = createTraceRequestSemantic({
      anthropic: {
        model: 'deepseek-v4-flash-vision-exp',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        messages: [{
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'computer_1',
            content: [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
            }],
          }],
        }],
      },
      upstream: { messages: [{ role: 'tool', content: `data:image/jpeg;base64,${imageData}` }] },
    }, 'proxy')

    expect(semantic).toMatchObject({
      version: 1,
      request: {
        model: 'deepseek-v4-flash-vision-exp',
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        messages: [{
          content: [{
            type: 'tool_result',
            tool_use_id: 'computer_1',
            content: [{
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                bytes: 12,
                sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
              },
            }],
          }],
        }],
      },
    })
    expect(JSON.stringify(semantic)).not.toContain(imageData)
    expect(JSON.stringify(semantic)).not.toContain('upstream')
  })
})
