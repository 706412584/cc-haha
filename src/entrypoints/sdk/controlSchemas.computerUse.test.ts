import { describe, expect, test } from 'bun:test'
import { SDKControlRequestSchema } from './controlSchemas.js'

describe('Computer Use desktop approval bootstrap control message', () => {
  test('accepts only a fixed-size process capability', () => {
    const message = {
      type: 'control_request',
      request_id: 'cu-bootstrap-1',
      request: {
        subtype: 'set_computer_use_approval_token',
        token: '4'.repeat(64),
      },
    }

    expect(SDKControlRequestSchema().safeParse(message).success).toBe(true)
    expect(SDKControlRequestSchema().safeParse({
      ...message,
      request: { ...message.request, token: 'short' },
    }).success).toBe(false)
  })
})
