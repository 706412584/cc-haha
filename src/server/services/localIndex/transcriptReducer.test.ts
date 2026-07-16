import { describe, expect, it } from 'bun:test'
import type { SessionListSummary, TranscriptChunk, TranscriptProjection } from './types.js'
import {
  LOCAL_INDEX_REBUILD_REQUIRED,
  TranscriptRebuildRequiredError,
  reduceTranscript,
} from './transcriptReducer.js'

const birthtime = '2025-12-31T23:59:00.000Z'
const mtime = '2026-01-02T00:00:00.000Z'

function initialProjection(overrides: Partial<SessionListSummary> = {}): TranscriptProjection {
  return {
    summary: {
      title: 'Untitled Session',
      createdAt: birthtime,
      modifiedAt: mtime,
      messageCount: 0,
      workDir: '/fallback/project',
      ...overrides,
    },
    indexedBytes: 0,
    pendingTailBytes: 0,
    malformedLineCount: 0,
  }
}

function completeChunks(
  entries: Array<Record<string, unknown> | string>,
  byteStart = 0,
): TranscriptChunk[] {
  let nextByte = byteStart
  return entries.map((entry) => {
    const text = `${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n`
    const chunk = { text, byteStart: nextByte, completeLine: true }
    nextByte += Buffer.byteLength(text)
    return chunk
  })
}

function user(content: unknown, timestamp: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    message: { role: 'user', content },
    timestamp,
    ...extra,
  }
}

function assistant(timestamp: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    timestamp,
    ...extra,
  }
}

describe('reduceTranscript', () => {
  it('projects the existing summary fields and title precedence from complete lines', () => {
    const repository = {
      requestedWorkDir: '/repo',
      repoRoot: '/repo',
      branch: 'main',
      worktree: true,
      baseRef: 'main',
      worktreePath: '/repo/.claude/worktrees/task',
      worktreeBranch: 'worktree-task',
      worktreeSlug: 'task',
    }
    const worktreeSession = {
      originalCwd: '/repo',
      worktreePath: '/repo/.claude/worktrees/task',
      worktreeName: 'task',
      sessionId: 'same-id',
    }
    const chunks = completeChunks([
      {
        type: 'session-meta',
        isMeta: true,
        workDir: 'D:\\workspace\\repo',
        permissionMode: 'acceptEdits',
        runtimeProviderId: 'provider-a',
        runtimeModelId: 'model-a',
        effortLevel: 'high',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      user('First user title', '2026-01-01T00:01:00.000Z', {
        cwd: 'D:\\workspace\\fallback',
        repository,
      }),
      assistant('2026-01-01T00:02:00.000Z'),
      {
        type: 'ai-title',
        aiTitle: 'AI title',
        timestamp: '2026-01-01T00:03:00.000Z',
      },
      {
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name><command-args>Ship projection</command-args>',
        timestamp: '2026-01-01T00:04:00.000Z',
      },
      {
        type: 'worktree-state',
        worktreeSession,
        timestamp: '2026-01-01T00:05:00.000Z',
      },
      {
        type: 'custom-title',
        customTitle: 'Pinned title',
        timestamp: '2026-01-01T00:06:00.000Z',
      },
    ])

    const result = reduceTranscript(chunks, initialProjection())

    expect(result.summary).toEqual({
      title: 'Pinned title',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:02:00.000Z',
      messageCount: 2,
      workDir: 'D:\\workspace\\repo',
      permissionMode: 'acceptEdits',
      runtimeProviderId: 'provider-a',
      runtimeModelId: 'model-a',
      effortLevel: 'high',
      repository,
      worktreeSession,
    })
    expect(result.indexedBytes).toBe(chunks.reduce(
      (bytes, chunk) => Math.max(bytes, chunk.byteStart + Buffer.byteLength(chunk.text)),
      0,
    ))
    expect(result.pendingTailBytes).toBe(0)
    expect(result.malformedLineCount).toBe(0)
  })

  it.each([
    ['first user', [user('First user', '2026-01-01T00:01:00.000Z')], 'First user'],
    ['AI over first user', [
      user('First user', '2026-01-01T00:01:00.000Z'),
      { type: 'ai-title', aiTitle: 'AI title' },
    ], 'AI title'],
    ['goal over AI', [
      user('First user', '2026-01-01T00:01:00.000Z'),
      { type: 'ai-title', aiTitle: 'AI title' },
      {
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name><command-args>Goal title</command-args>',
      },
    ], '/goal Goal title'],
    ['custom over goal', [
      {
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name><command-args>Goal title</command-args>',
      },
      { type: 'custom-title', customTitle: 'Custom title' },
    ], 'Custom title'],
  ])('keeps %s title precedence', (_label, entries, expectedTitle) => {
    const result = reduceTranscript(
      completeChunks(entries as Array<Record<string, unknown>>),
      initialProjection(),
    )

    expect(result.summary.title).toBe(expectedTitle)
  })

  it('counts malformed complete lines but leaves an incomplete tail pending', () => {
    const complete = completeChunks([
      user('你好', '2026-01-01T00:01:00.000Z'),
      '{malformed json}',
    ])
    const tailText = '{"type":"assistant"'
    const tailByteStart = complete.at(-1)!.byteStart + Buffer.byteLength(complete.at(-1)!.text)

    const result = reduceTranscript([
      ...complete,
      { text: tailText, byteStart: tailByteStart, completeLine: false },
    ], initialProjection())

    expect(result.summary.messageCount).toBe(1)
    expect(result.indexedBytes).toBe(tailByteStart)
    expect(result.pendingTailBytes).toBe(Buffer.byteLength(tailText))
    expect(result.malformedLineCount).toBe(1)
  })

  it('does not reclassify a parsed null entry as a JSON parse failure', () => {
    expect(() => reduceTranscript(
      completeChunks(['null']),
      initialProjection(),
    )).toThrow()
  })

  it('keeps semantic activity time while applying metadata-only appends', () => {
    const firstChunks = completeChunks([
      user('Original title', '2026-01-01T00:01:00.000Z'),
      assistant('2026-01-01T00:02:00.000Z'),
    ])
    const first = reduceTranscript(firstChunks, initialProjection())
    const appendStart = first.indexedBytes
    const metadataChunks = completeChunks([
      {
        type: 'session-meta',
        isMeta: true,
        workDir: '/new/worktree',
        runtimeProviderId: null,
        runtimeModelId: 'model-b',
        effortLevel: 'max',
        timestamp: '2026-01-03T00:00:00.000Z',
      },
      {
        type: 'custom-title',
        customTitle: 'Renamed without activity',
        timestamp: '2026-01-03T00:01:00.000Z',
      },
    ], appendStart)

    const result = reduceTranscript(metadataChunks, first)

    expect(result.summary).toMatchObject({
      title: 'Renamed without activity',
      createdAt: '2026-01-01T00:01:00.000Z',
      modifiedAt: '2026-01-01T00:02:00.000Z',
      messageCount: 2,
      workDir: '/new/worktree',
      runtimeProviderId: null,
      runtimeModelId: 'model-b',
      effortLevel: 'max',
    })
    expect(result.indexedBytes).toBe(
      metadataChunks.at(-1)!.byteStart + Buffer.byteLength(metadataChunks.at(-1)!.text),
    )
  })

  it('preserves title-source precedence across stateful incremental reductions', () => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const aiChunks = completeChunks([
      { type: 'ai-title', aiTitle: 'AI title' },
    ], first.indexedBytes)
    const withAi = reduceTranscript(aiChunks, first)
    const goalChunks = completeChunks([{
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name><command-args>Goal title</command-args>',
    }], withAi.indexedBytes)
    const withGoal = reduceTranscript(goalChunks, withAi)
    const laterAiChunks = completeChunks([
      { type: 'ai-title', aiTitle: 'Later AI title' },
    ], withGoal.indexedBytes)
    const afterLaterAi = reduceTranscript(laterAiChunks, withGoal)
    const customChunks = completeChunks([
      { type: 'custom-title', customTitle: 'Custom title' },
    ], afterLaterAi.indexedBytes)

    expect(withAi.summary.title).toBe('AI title')
    expect(withGoal.summary.title).toBe('/goal Goal title')
    expect(afterLaterAi.summary.title).toBe('/goal Goal title')
    expect(reduceTranscript(customChunks, afterLaterAi).summary.title).toBe('Custom title')
  })

  it('requires a source rebuild for a state-less incremental seed', () => {
    const persistedLookingSeed: TranscriptProjection = {
      summary: {
        title: 'Existing title with unknown source',
        createdAt: '2026-01-01T00:01:00.000Z',
        modifiedAt: '2026-01-01T00:02:00.000Z',
        messageCount: 2,
        workDir: '/existing',
      },
      indexedBytes: 128,
      pendingTailBytes: 0,
      malformedLineCount: 0,
    }
    const append = completeChunks([
      { type: 'ai-title', aiTitle: 'Cannot safely rank this' },
    ], persistedLookingSeed.indexedBytes)

    expect(() => reduceTranscript(append, persistedLookingSeed)).toThrow(
      TranscriptRebuildRequiredError,
    )
    try {
      reduceTranscript(append, persistedLookingSeed)
      throw new Error('expected rebuild signal')
    } catch (error) {
      expect((error as TranscriptRebuildRequiredError).code).toBe(LOCAL_INDEX_REBUILD_REQUIRED)
    }
  })

  it('uses the stable rebuild signal for a negative state-less byte offset', () => {
    expect(() => reduceTranscript([{
      text: '{}\n',
      byteStart: -1,
      completeLine: true,
    }])).toThrow(TranscriptRebuildRequiredError)
  })

  it('keeps private reducer state when a no-op reduction clones a stateful seed', () => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const clone = reduceTranscript([], first)
    const append = completeChunks([
      { type: 'ai-title', aiTitle: 'AI title after no-op' },
    ], clone.indexedBytes)

    expect(reduceTranscript(append, clone).summary.title).toBe('AI title after no-op')
  })

  it.each([
    ['overlaps', -1],
    ['leaves a gap', 1],
  ])('requires a rebuild when the first incremental chunk %s the indexed boundary', (
    _label,
    delta,
  ) => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const append = completeChunks([
      { type: 'ai-title', aiTitle: 'Unsafe append' },
    ], first.indexedBytes + delta)

    expect(() => reduceTranscript(append, first)).toThrow(TranscriptRebuildRequiredError)
  })

  it.each([
    ['gap', 1],
    ['overlap', -1],
    ['out-of-order restart', 0],
  ])('requires a rebuild for a later chunk with a %s', (_label, secondStartDelta) => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const append = completeChunks([
      { type: 'ai-title', aiTitle: 'First contiguous append' },
    ], first.indexedBytes)
    const expectedSecondStart = append[0]!.byteStart + Buffer.byteLength(append[0]!.text)
    append.push(...completeChunks([
      { type: 'custom-title', customTitle: 'Unsafe second append' },
    ], secondStartDelta === 0 ? first.indexedBytes : expectedSecondStart + secondStartDelta))

    expect(() => reduceTranscript(append, first)).toThrow(TranscriptRebuildRequiredError)
  })

  it('requires a rebuild when any chunk follows an incomplete tail', () => {
    const first = reduceTranscript(
      completeChunks([user('First user', '2026-01-01T00:01:00.000Z')]),
      initialProjection(),
    )
    const tailText = '{"type":"assistant"'
    const laterText = `${JSON.stringify({ type: 'custom-title', customTitle: 'Too late' })}\n`

    expect(() => reduceTranscript([
      { text: tailText, byteStart: first.indexedBytes, completeLine: false },
      {
        text: laterText,
        byteStart: first.indexedBytes + Buffer.byteLength(tailText),
        completeLine: true,
      },
    ], first)).toThrow(TranscriptRebuildRequiredError)
  })

  it('uses the explicit seed fallbacks when no semantic entries exist', () => {
    const chunks = completeChunks([{
      type: 'session-meta',
      isMeta: true,
      permissionMode: 'not-valid',
      effortLevel: 'not-valid',
    }])

    const result = reduceTranscript(chunks, initialProjection())

    expect(result.summary).toEqual({
      title: 'Untitled Session',
      createdAt: birthtime,
      modifiedAt: mtime,
      messageCount: 0,
      workDir: '/fallback/project',
    })
  })
})
