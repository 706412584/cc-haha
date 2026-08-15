import { describe, expect, test } from 'bun:test'
import {
  SDKControlGetSettingsResponseSchema,
  SDKControlRequestSchema,
} from './controlSchemas.js'

describe('SDKControlGetSettingsResponseSchema effort', () => {
  test('accepts every runtime named effort level including xhigh', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(
        SDKControlGetSettingsResponseSchema().safeParse({
          effective: {},
          sources: [],
          applied: {
            model: 'gpt-5.6-sol',
            effort,
          },
        }).success,
      ).toBe(true)
    }
  })

  test('rejects unknown runtime effort values', () => {
    expect(
      SDKControlGetSettingsResponseSchema().safeParse({
        effective: {},
        sources: [],
        applied: {
          model: 'gpt-5.6-sol',
          effort: 'extreme',
        },
      }).success,
    ).toBe(false)
  })
})

describe('SDKControlRequestSchema agent continuation', () => {
  test('accepts a typed follow-up message for an existing subagent', () => {
    expect(SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'continue-1',
      request: {
        subtype: 'send_agent_message',
        agent_id: 'agent-123',
        content: 'Continue reviewing the patch.',
      },
    }).success).toBe(true)
  })

  test('rejects an empty follow-up message', () => {
    expect(SDKControlRequestSchema().safeParse({
      type: 'control_request',
      request_id: 'continue-2',
      request: {
        subtype: 'send_agent_message',
        agent_id: 'agent-123',
        content: '',
      },
    }).success).toBe(false)
  })
})
