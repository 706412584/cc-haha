import { describe, expect, test } from 'bun:test'
import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKUserMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import { PrintPartialOutputTracker } from './partialOutput.js'

describe('PrintPartialOutputTracker', () => {
  test('combines completed text blocks from the failed response', () => {
    const tracker = new PrintPartialOutputTracker()

    tracker.observe(assistant('response-a', 'first'))
    tracker.observe(assistant('response-a', ' second'))
    tracker.observe(assistant('synthetic-error', 'API Error: failed', 'unknown'))

    expect(tracker.formatResult('API Error: failed', true)).toBe(
      'first second\nAPI Error: failed',
    )
  })

  test('does not duplicate normal results or the same error text', () => {
    const tracker = new PrintPartialOutputTracker()

    tracker.observe(assistant('response-a', 'complete'))

    expect(tracker.formatResult('complete', false)).toBe('complete')
    expect(tracker.formatResult('complete', true)).toBe('complete')
    expect(tracker.formatResultLine('complete', false)).toBe('complete\n')
    expect(tracker.formatResultLine('complete\n', false)).toBe('complete\n')
  })

  test.each([
    ['a user turn', user()],
    ['a compact boundary', compactBoundary()],
  ])('resets accumulated text at %s', (_name, boundary) => {
    const tracker = new PrintPartialOutputTracker()

    tracker.observe(assistant('response-a', 'stale'))
    tracker.observe(boundary)

    expect(tracker.formatResult('API Error: failed', true)).toBe(
      'API Error: failed',
    )
  })

  test('keeps only the newest assistant response', () => {
    const tracker = new PrintPartialOutputTracker()

    tracker.observe(assistant('response-a', 'stale'))
    tracker.observe(assistant('response-b', 'current'))
    tracker.observe(assistant('response-error', 'API Error: failed', 'unknown'))

    expect(tracker.formatResult('API Error: failed', true)).toBe(
      'current\nAPI Error: failed',
    )
  })

  test('keeps the prior partial when a new response contains an untagged terminal error', () => {
    const tracker = new PrintPartialOutputTracker()

    tracker.observe(assistant('response-a', 'partial'))
    tracker.observe(assistant('response-b', 'Image was too large to process.'))

    expect(
      tracker.formatResult('Image was too large to process.', true),
    ).toBe('partial\nImage was too large to process.')
  })

  test('does not duplicate identical prior and terminal text', () => {
    const tracker = new PrintPartialOutputTracker()

    tracker.observe(assistant('response-a', 'same'))
    tracker.observe(assistant('response-b', 'same'))

    expect(tracker.formatResult('same', true)).toBe('same')
  })

  test('does not combine two known error responses', () => {
    const tracker = new PrintPartialOutputTracker()

    tracker.observe(assistant('response-a', 'API Error: first', 'unknown'))
    tracker.observe(assistant('response-b', 'API Error: final', 'unknown'))

    expect(tracker.formatResult('API Error: final', true)).toBe(
      'API Error: final',
    )
  })

  test('ignores nested assistant messages', () => {
    const tracker = new PrintPartialOutputTracker()
    const nested = assistant('response-a', 'nested')
    nested.parent_tool_use_id = 'tool-parent'

    tracker.observe(nested)

    expect(tracker.formatResult('API Error: failed', true)).toBe(
      'API Error: failed',
    )
  })
})

function assistant(
  id: string,
  text: string,
  error?: SDKAssistantMessage['error'],
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    session_id: 'test-session',
    uuid: crypto.randomUUID(),
    error,
  }
}

function user(): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: 'next turn' },
    parent_tool_use_id: null,
    session_id: 'test-session',
    uuid: crypto.randomUUID(),
  }
}

function compactBoundary(): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 'test-session',
    uuid: crypto.randomUUID(),
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: 1,
    },
  } as SDKCompactBoundaryMessage
}
