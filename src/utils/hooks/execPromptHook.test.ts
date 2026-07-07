import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { PromptHook } from '../settings/types.js'

const queryModelWithoutStreamingMock = mock(async () => ({
  message: {
    content: [{ type: 'text', text: 'not json' }],
  },
}))

mock.module('../../services/api/claude.js', () => ({
  queryModelWithoutStreaming: queryModelWithoutStreamingMock,
}))

const { execPromptHook } = await import('./execPromptHook.js')

function makeContext(): ToolUseContext {
  let responseLength = 0
  return {
    abortController: new AbortController(),
    agentId: undefined,
    getAppState: () => ({
      toolPermissionContext: { mode: 'default' },
    }),
    options: {
      tools: [],
    },
    setResponseLength: updater => {
      responseLength = updater(responseLength)
    },
  } as unknown as ToolUseContext
}

const goalHook = {
  type: 'prompt',
  prompt: [
    '<cc-haha-goal-hook>',
    '<goal-objective>',
    'ship the goal',
    '</goal-objective>',
  ].join('\n'),
  timeout: 1,
} satisfies PromptHook

const ordinaryHook = {
  type: 'prompt',
  prompt: 'ordinary prompt hook',
  timeout: 1,
} satisfies PromptHook

describe('execPromptHook goal failures', () => {
  beforeEach(() => {
    queryModelWithoutStreamingMock.mockClear()
    queryModelWithoutStreamingMock.mockImplementation(async () => ({
      message: {
        content: [{ type: 'text', text: 'not json' }],
      },
    }))
  })

  test('turns invalid /goal evaluator JSON into blocking continuation feedback', async () => {
    const result = await execPromptHook(
      goalHook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      makeContext(),
    )

    expect(result.outcome).toBe('blocking')
    expect(result.preventContinuation).toBe(true)
    expect(result.blockingError?.command).toContain('<cc-haha-goal-hook>')
    expect(result.blockingError?.blockingError).toContain('response was not valid JSON')
    expect(result.blockingError?.blockingError).toContain('continue working toward it')
  })

  test('keeps ordinary prompt hook invalid JSON as a non-blocking hook error', async () => {
    const result = await execPromptHook(
      ordinaryHook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      makeContext(),
    )

    expect(result.outcome).toBe('non_blocking_error')
    expect(result.preventContinuation).toBeUndefined()
    expect(result.blockingError).toBeUndefined()
    expect(result.message?.attachment.type).toBe('hook_non_blocking_error')
  })

  test('turns /goal evaluator schema failures into blocking continuation feedback', async () => {
    queryModelWithoutStreamingMock.mockImplementation(async () => ({
      message: {
        content: [{ type: 'text', text: '{"ok":"not boolean"}' }],
      },
    }))

    const result = await execPromptHook(
      goalHook,
      'Stop',
      'Stop',
      '{}',
      new AbortController().signal,
      makeContext(),
    )

    expect(result.outcome).toBe('blocking')
    expect(result.preventContinuation).toBe(true)
    expect(result.blockingError?.blockingError).toContain('expected schema')
  })
})
