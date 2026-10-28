// The tests in this file replace ../api/claude.js with a stub whose
// getMaxOutputTokensForModel returns a fixed 20_000. Bun's module mocks are
// process-wide and cannot be undone, so they live in their own file: keeping
// them in compact.test.ts made every later describe that needs the real
// implementation read the stub, and the fork-allowance assertions collapsed
// to `undefined`.
import { describe, expect, mock, test } from 'bun:test'
import * as realClaude from '../api/claude.js'
import type { Message } from '../../types/message.js'

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
    // Spread the real module: partial mocks break any consumer that imports
    // another export (getAPIMetadata, etc.).
    mock.module('../api/claude.js', () => ({
      ...realClaude,
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

  test('ends the compaction at the wall clock even when the summarize request ignores the abort signal', async () => {
    process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = '50'
    const parentAbort = new AbortController()
    // A trickling relay never observes compactAbort: the request keeps its
    // socket open well past the 5-minute budget, so the abort signal alone
    // cannot unstick the compaction. Only the raced deadline can.
    const streamingMock = mock(async function* () {
      await new Promise(resolve => setTimeout(resolve, 5_000))
      yield { type: 'assistant' } as never
    }) as unknown as any
    // Spread the real module: partial mocks break any consumer that imports
    // another export (getAPIMetadata, etc.).
    mock.module('../api/claude.js', () => ({
      ...realClaude,
      queryModelWithStreaming: streamingMock,
      getMaxOutputTokensForModel: () => 20_000,
    }))

    const { compactConversation, ERROR_MESSAGE_COMPACT_TIMEOUT } = await import(
      './compact.js'
    )

    const startedAt = Date.now()
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
    const elapsedMs = Date.now() - startedAt

    expect(surfacedError).toBeInstanceOf(Error)
    expect((surfacedError as Error).message).toBe(ERROR_MESSAGE_COMPACT_TIMEOUT)
    // Without the race this resolves only when the mock finishes (~5s), which
    // is what left the desktop stuck on "thinking" until the 600s stream cap.
    expect(elapsedMs).toBeLessThan(2_500)

    if (ORIGINAL === undefined) delete process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS
    else process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = ORIGINAL
  }, 15_000)

  test('bounds partial compaction by the same wall clock when the summarize request hangs', async () => {
    process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = '50'
    const parentAbort = new AbortController()
    const streamingMock = mock(async function* () {
      await new Promise(resolve => setTimeout(resolve, 5_000))
      yield { type: 'assistant' } as never
    }) as unknown as any
    // Spread the real module: partial mocks break any consumer that imports
    // another export (getAPIMetadata, etc.).
    mock.module('../api/claude.js', () => ({
      ...realClaude,
      queryModelWithStreaming: streamingMock,
      getMaxOutputTokensForModel: () => 20_000,
    }))

    const { partialCompactConversation, ERROR_MESSAGE_COMPACT_TIMEOUT } = await import(
      './compact.js'
    )

    const messages = makeMessages()
    const startedAt = Date.now()
    let surfacedError: unknown
    try {
      await partialCompactConversation(
        messages,
        0,
        makeToolUseContext(parentAbort),
        {
          systemPrompt: [],
          userContext: {},
          systemContext: {},
          toolUseContext: makeToolUseContext(parentAbort),
          forkContextMessages: messages,
        },
        undefined,
        'from',
      )
    } catch (error) {
      surfacedError = error
    }
    const elapsedMs = Date.now() - startedAt

    // Partial compaction shares armCompactTimeout, so it must be bounded by the
    // same race rather than waiting out the abandoned request.
    expect(elapsedMs).toBeLessThan(2_500)
    expect(surfacedError).toBeInstanceOf(Error)
    expect((surfacedError as Error).message).toBe(ERROR_MESSAGE_COMPACT_TIMEOUT)

    if (ORIGINAL === undefined) delete process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS
    else process.env.CLAUDE_CODE_COMPACT_TIMEOUT_MS = ORIGINAL
  }, 15_000)
})

