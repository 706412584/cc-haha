import { describe, expect, test } from 'bun:test'

import { classifyRuntimeErrorCode } from '../ws/cliMessageParsing.js'

/**
 * The watchdog messages are built in src/services/api/streamWatchdog.ts and
 * matched here by substring. The thinking and max-duration branches are the
 * risky pair: both describe an aborted stream, so a reworded message could
 * silently fall through to the wrong code and change what the desktop reports.
 */
describe('classifyRuntimeErrorCode', () => {
  test('maps each watchdog abort message to its own code', () => {
    const cases: Array<[string, string]> = [
      [
        'Tool input generation exceeded 120s - aborting incomplete tool call (last event: input_json_delta)',
        'STREAM_TOOL_INPUT_DURATION',
      ],
      [
        'Thinking stream exceeded 300s without producing text or a tool call - aborting stalled reasoning loop (last event: thinking_delta, events: 256763)',
        'STREAM_THINKING_DURATION',
      ],
      [
        'Stream max duration exceeded - no completion received after 600s (last event: thinking_delta, events: 256763)',
        'STREAM_MAX_DURATION',
      ],
      [
        'Provider stream stalled after partial response - no new chunks for 240s (last event: text_delta)',
        'STREAM_IDLE_TIMEOUT',
      ],
      ['Stream idle timeout - no stream events received for 90s', 'STREAM_IDLE_TIMEOUT'],
    ]

    for (const [message, expected] of cases) {
      expect(classifyRuntimeErrorCode(message, 'FALLBACK')).toBe(expected)
    }
  })

  test('keeps the fallback code for unrelated errors', () => {
    expect(classifyRuntimeErrorCode('Connection reset by peer', 'API_ERROR')).toBe('API_ERROR')
    expect(classifyRuntimeErrorCode('', 'FALLBACK')).toBe('FALLBACK')
  })
})
