import { describe, expect, mock, test } from 'bun:test'

import {
  buildPostCompactMessages,
  type CompactionResult,
  getCompactTimeoutMs,
} from './compact.js'
import { getCurrentUsage } from '../../utils/tokens.js'
import type { Message } from '../../types/message.js'

const PRE_COMPACT_USAGE = {
  input_tokens: 150_000,
  output_tokens: 900,
  cache_creation_input_tokens: 2_000,
  cache_read_input_tokens: 120_000,
  service_tier: 'standard',
}

function makeBoundary(): CompactionResult['boundaryMarker'] {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: '00000000-0000-0000-0000-000000000001',
    level: 'info',
    compactMetadata: { trigger: 'manual', preTokens: 150_000 },
  } as unknown as CompactionResult['boundaryMarker']
}

function makeSummaryMessage(): CompactionResult['summaryMessages'][number] {
  return {
    type: 'user',
    uuid: '00000000-0000-0000-0000-000000000002',
    timestamp: new Date().toISOString(),
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued…' },
  } as unknown as CompactionResult['summaryMessages'][number]
}

function makePreservedAssistant(): Message {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000003',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_old',
      role: 'assistant',
      model: 'mock-model',
      content: [{ type: 'text', text: 'old reply kept after compact' }],
      stop_reason: 'end_turn',
      usage: { ...PRE_COMPACT_USAGE },
    },
  } as unknown as Message
}

function makePreservedUser(): Message {
  return {
    type: 'user',
    uuid: '00000000-0000-0000-0000-000000000004',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'kept user message' },
  } as unknown as Message
}

function makeResult(messagesToKeep?: Message[]): CompactionResult {
  return {
    boundaryMarker: makeBoundary(),
    summaryMessages: [makeSummaryMessage()],
    attachments: [],
    hookResults: [],
    ...(messagesToKeep ? { messagesToKeep } : {}),
  }
}

describe('buildPostCompactMessages stale-usage stripping (#743)', () => {
  test('zeroes provider usage on preserved assistant messages', () => {
    const kept = makePreservedAssistant()
    const result = buildPostCompactMessages(makeResult([kept, makePreservedUser()]))

    const assistant = result.find(m => m.type === 'assistant') as {
      message: { usage: Record<string, unknown> }
    }
    expect(assistant.message.usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    // Non-token usage metadata survives the strip.
    expect(assistant.message.usage.service_tier).toBe('standard')
  })

  test('does not mutate the original preserved message', () => {
    const kept = makePreservedAssistant()
    buildPostCompactMessages(makeResult([kept]))

    expect(
      (kept as unknown as { message: { usage: { input_tokens: number } } })
        .message.usage.input_tokens,
    ).toBe(150_000)
  })

  test('keeps ordering and passes non-assistant messages through untouched', () => {
    const keptUser = makePreservedUser()
    const result = buildPostCompactMessages(makeResult([keptUser]))

    expect(result[0]?.type).toBe('system')
    expect(result[1]?.type).toBe('user')
    expect(result[2]).toBe(keptUser)
  })

  test('post-compact view no longer anchors getCurrentUsage to the pre-compact request size', () => {
    const result = buildPostCompactMessages(
      makeResult([makePreservedUser(), makePreservedAssistant()]),
    )

    // getCurrentUsage skips zeroed usage (its stale placeholder convention),
    // so the context meter falls back to the local estimate and recovers
    // immediately instead of staying pinned at the pre-compact 100%.
    expect(getCurrentUsage(result)).toBeNull()
  })

  test('handles results without messagesToKeep', () => {
    const result = buildPostCompactMessages(makeResult())
    expect(result).toHaveLength(2)
    expect(getCurrentUsage(result)).toBeNull()
  })
})

describe('getCompactTimeoutMs env override', () => {
  const ORIGINAL = process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS

  test('defaults to 5 minutes', () => {
    delete process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS
    expect(getCompactTimeoutMs()).toBe(5 * 60_000)
  })

  test('honors a positive override', () => {
    process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = '12345'
    expect(getCompactTimeoutMs()).toBe(12_345)
  })

  test('0 disables the timeout', () => {
    process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = '0'
    expect(getCompactTimeoutMs()).toBe(0)
  })

  test('ignores negative and non-numeric values', () => {
    process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = '-1'
    expect(getCompactTimeoutMs()).toBe(5 * 60_000)
    process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = 'abc'
    expect(getCompactTimeoutMs()).toBe(5 * 60_000)
  })

  if (ORIGINAL === undefined) delete process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS
  else process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = ORIGINAL
})

describe('compactConversation hard timeout', () => {
  const ORIGINAL = process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS

  function makeToolUseContext(parentAbort: AbortController): any {
    return {
      options: {
        mainLoopModel: 'test-model',
        tools: [],
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: parentAbort,
      readFileState: new Map(),
      messages: [],
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      getAppState: () => ({}) as any,
      setAppState: () => {},
    }
  }

  function makeMessages(): Message[] {
    return [
      {
        type: 'user',
        uuid: '00000000-0000-0000-0000-00000000a001',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'hello' },
      } as unknown as Message,
    ]
  }

  test('re-tags the surfaced error as compact timeout and leaves the parent signal intact', async () => {
    process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = '50'
    const parentAbort = new AbortController()
    // The summarize request hangs until the timeout aborts the child.
    // queryModelWithStreaming is mocked because the streaming fallback path
    // (streamCompactSummary) is what consumes compactAbort.signal.
    const streamingMock = mock(async function* () {
      await new Promise(resolve => setTimeout(resolve, 10_000))
      yield { type: 'assistant' } as never
    }) as unknown as typeof import('./compact.js')['compactConversation'] extends never
      ? never
      : any
    mock.module('../api/claude.js', () => ({
      queryModelWithStreaming: streamingMock,
      getMaxOutputTokensForModel: () => 20_000,
    }))

    const { compactConversation, ERROR_MESSAGE_COMPACT_TIMEOUT } = await import(
      './compact.js'
    )

    let surfacedError: unknown
    try {
      await compactConversation(
        makeMessages(),
        makeToolUseContext(parentAbort),
        {
          systemPrompt: [],
          userContext: {},
          systemContext: {},
          toolUseContext: makeToolUseContext(parentAbort),
          forkContextMessages: makeMessages(),
        },
        true,
        undefined,
        true, // isAutoCompact
      )
    } catch (error) {
      surfacedError = error
    }

    expect(surfacedError).toBeInstanceOf(Error)
    expect((surfacedError as Error).message).toBe(ERROR_MESSAGE_COMPACT_TIMEOUT)
    expect(parentAbort.signal.aborted).toBe(false)

    if (ORIGINAL === undefined) delete process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS
    else process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = ORIGINAL
  }, 15_000)
})
