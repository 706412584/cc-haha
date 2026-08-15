import { describe, expect, test } from 'bun:test'
import {
  roughTokenCountEstimationForContent,
} from './tokenEstimation.js'
import { OPENAI_REASONING_ENVELOPE_PREFIX } from '../utils/openAIReasoningEnvelope.js'

describe('roughTokenCountEstimationForContent', () => {
  test('does not treat OpenAI encrypted reasoning bytes as plaintext tokens', () => {
    const data = `${OPENAI_REASONING_ENVELOPE_PREFIX}${JSON.stringify({
      id: 'rs_test',
      summary: [{ type: 'summary_text', text: 'visible summary' }],
      encrypted_content: 'x'.repeat(400_000),
    })}`

    expect(
      roughTokenCountEstimationForContent([
        { type: 'redacted_thinking', data },
      ]),
    ).toBe(4)
  })

  test('keeps estimating non-OpenAI redacted thinking payloads', () => {
    expect(
      roughTokenCountEstimationForContent([
        { type: 'redacted_thinking', data: 'x'.repeat(400) },
      ]),
    ).toBe(100)
  })
})
