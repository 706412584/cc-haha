import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { withStreamRetry } from './streamRetry.js'
import {
  isRetryableStreamError,
  RetriableStreamError,
} from './withRetry.js'

const RETRY_ENV = 'CLAUDE_STREAM_TRANSIENT_RETRY_MAX'

// getAssistantMessageFromError() (invoked when retries are exhausted) consults
// isClaudeAISubscriber(), which throws if no auth is configured. We only assert
// that an assistant error message is produced, so a dummy key suffices. In
// production this path always runs with real auth already in place.
let priorApiKey: string | undefined
beforeAll(() => {
  priorApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test'
})
afterAll(() => {
  if (priorApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  }
})

/** A RetriableStreamError wrapping a realistic mid-stream api_error (no status). */
function retriableError(requestID?: string): RetriableStreamError {
  const body = {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Failed to generate a valid tool call.',
    },
  }
  const error = new APIError(undefined, body, JSON.stringify(body), undefined)
  return new RetriableStreamError(error, requestID)
}

// biome-ignore lint/suspicious/noExplicitAny: test harness collects heterogeneous stream messages
async function collect(gen: AsyncGenerator<any, void>): Promise<any[]> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const out: any[] = []
  for await (const m of gen) out.push(m)
  return out
}

describe('withStreamRetry', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test'
  })
  test('retries the screenshot upstream_error after the SDK parses it from SSE', async () => {
    process.env[RETRY_ENV] = '1'
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1
        const payload = requests === 1
          ? [
              'event: error',
              `data: ${JSON.stringify({
                error: {
                  message: 'Upstream service temporarily unavailable',
                  type: 'upstream_error',
                },
                type: 'error',
              })}`,
              '',
              '',
            ].join('\n')
          : [
              'event: message_start',
              `data: ${JSON.stringify({
                type: 'message_start',
                message: {
                  id: 'msg_recovered',
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: 'claude-test',
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              })}`,
              '',
              'event: message_delta',
              `data: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 1 },
              })}`,
              '',
              'event: message_stop',
              `data: ${JSON.stringify({ type: 'message_stop' })}`,
              '',
              '',
            ].join('\n')
        return new Response(payload, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const client = new Anthropic({
      apiKey: 'sk-ant-test',
      baseURL: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
    })
    const attempt = () =>
      (async function* () {
        try {
          const stream = client.messages.stream({
            model: 'claude-test',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'hello' }],
          })
          await stream.finalMessage()
          yield { type: 'assistant', message: { content: [] }, uuid: 'recovered' } as any
        } catch (error) {
          if (isRetryableStreamError(error)) {
            throw new RetriableStreamError(error)
          }
          throw error
        }
      })()

    try {
      const out = await collect(withStreamRetry(attempt, 'claude-test', []))
      expect(requests).toBe(2)
      expect(out).toContainEqual(expect.objectContaining({
        type: 'system',
        subtype: 'streaming_fallback',
        cause: 'stream_retry',
      }))
      expect(out.at(-1)).toMatchObject({ type: 'assistant', uuid: 'recovered' })
      expect(out.some((message) => message.isApiErrorMessage)).toBe(false)
    } finally {
      server.stop(true)
      delete process.env[RETRY_ENV]
    }
  })

  test('retries a Grok disconnect and only exposes the final error after exhaustion', async () => {
    process.env[RETRY_ENV] = '1'
    let calls = 0
    const disconnect = new Error(
      'API Error: {"error":{"message":"OpenAI messages stream disconnected before completion","type":"api_error"},"type":"error"}',
    )
    const attempt = () =>
      (async function* (): AsyncGenerator<any, void> {
        calls += 1
        if (!isRetryableStreamError(disconnect)) throw disconnect
        throw new RetriableStreamError(disconnect)
      })()

    const out = await collect(withStreamRetry(attempt, 'grok-4', []))

    expect(calls).toBe(2)
    expect(out.filter(
      message => message.type === 'assistant' && message.isApiErrorMessage === true,
    )).toHaveLength(1)
    const text = out.at(-1)?.message?.content?.find((block: { type: string }) => block.type === 'text')?.text
    expect(text).toContain('OpenAI messages stream disconnected before completion')
    delete process.env[RETRY_ENV]
  })

  test('uses four retries by default and only shows the final connection error', async () => {
    delete process.env[RETRY_ENV]
    let calls = 0
    const connectionError = new APIConnectionError({
      cause: new Error('The socket connection was closed unexpectedly.'),
    })
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw new RetriableStreamError(connectionError)
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(5)
    expect(out.filter(
      m => m.type === 'assistant' && m.isApiErrorMessage === true,
    )).toHaveLength(1)
    const text = out.at(-1)?.message?.content?.find((block: { type: string }) => block.type === 'text')?.text
    expect(text).toContain('Retried 4 times')
  }, 15_000)

  test('retries after a transient mid-stream error and yields the successful attempt', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          // A failed attempt may have already emitted partials before throwing.
          yield { type: 'stream_event', event: { type: 'message_start' } }
          throw retriableError()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'ok' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(2)
    expect(out).toContainEqual(expect.objectContaining({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'stream_retry',
    }))
    const assistants = out.filter(m => m.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].uuid).toBe('ok')
    // The successful retry must NOT be reported as an API error.
    expect(out.some(m => m.isApiErrorMessage)).toBe(false)
    delete process.env[RETRY_ENV]
  })

  test('exhausts retries and surfaces an API-error assistant message', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(3) // 1 initial attempt + 2 retries
    expect(out.filter(
      m => m.type === 'system' && m.subtype === 'streaming_fallback' && m.cause === 'stream_retry',
    )).toHaveLength(2)
    const last = out.at(-1)
    expect(last?.type).toBe('assistant')
    expect(last?.isApiErrorMessage).toBe(true)
    // User-visible error message must be yielded EXACTLY ONCE — no matter
    // how many retries fired in the middle. Per user requirement: "重试可以
    // 但是只显示一次报错消息出就行". Without this assertion, a future
    // refactor that yields per-attempt error messages could regress the UI
    // to show a stack of red error chips.
    const errorMessages = out.filter(
      (m) => m.type === 'assistant' && m.isApiErrorMessage === true,
    )
    expect(errorMessages).toHaveLength(1)
    delete process.env[RETRY_ENV]
  })

  test('final error says how many retries ran and preserves the upstream request ID', async () => {
    process.env[RETRY_ENV] = '2'
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        throw retriableError('req-stream-final')
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))
    const last = out.at(-1)
    const text = last?.message?.content?.find((block: { type: string }) => block.type === 'text')?.text
    expect(text).toContain('Retried 2 times')
    expect(last?.requestId).toBe('req-stream-final')
    delete process.env[RETRY_ENV]
  })

  test('retry attempts do not leak any error messages mid-stream (transparent retry)', async () => {
    // attempt 1 throws RetriableStreamError, attempt 2 succeeds. The user
    // must see ZERO error messages — the retry should be invisible.
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          throw retriableError()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'recovered' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(2)
    expect(
      out.some(
        (m) => m.type === 'assistant' && m.isApiErrorMessage === true,
      ),
    ).toBe(false)
    delete process.env[RETRY_ENV]
  })

  test('does not retry a transient stream error after the caller aborts', async () => {
    process.env[RETRY_ENV] = '2'
    const controller = new AbortController()
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        controller.abort()
        throw retriableError()
      })()

    await expect(
      collect(withStreamRetry(attempt, 'test-model', [], controller.signal)),
    ).rejects.toThrow()
    expect(calls).toBe(1)
    delete process.env[RETRY_ENV]
  })

  test('stream_retry payload includes attempt metadata for visible desktop banners', async () => {
    process.env[RETRY_ENV] = '2'
    let calls = 0
    const disconnect = new Error(
      'OpenAI messages stream disconnected before completion',
    )
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) throw new RetriableStreamError(disconnect)
        yield { type: 'assistant', message: { content: [] }, uuid: 'ok' }
      })()

    const out = await collect(withStreamRetry(attempt, 'grok-4', []))
    const retrySignals = out.filter(
      (m) =>
        m.type === 'system' &&
        m.subtype === 'streaming_fallback' &&
        m.cause === 'stream_retry',
    )
    expect(retrySignals).toHaveLength(1)
    expect(retrySignals[0].attempt).toBe(1)
    expect(retrySignals[0].maxRetries).toBe(2)
    expect(typeof retrySignals[0].retryDelayMs).toBe('number')
    expect(retrySignals[0].retryDelayMs).toBeGreaterThanOrEqual(0)
    expect(String(retrySignals[0].errorMessage)).toContain('disconnected')
    delete process.env[RETRY_ENV]
  })

  test('aborts during retry backoff without starting another attempt', async () => {
    process.env[RETRY_ENV] = '3'
    const controller = new AbortController()
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const gen = withStreamRetry(attempt, 'test-model', [], controller.signal)
    const first = await gen.next()
    expect(first.value).toMatchObject({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'stream_retry',
      attempt: 1,
    })
    controller.abort()
    await expect(gen.next()).rejects.toThrow()
    expect(calls).toBe(1)
    delete process.env[RETRY_ENV]
  })

  // Transport disconnects reach this wrapper as a bare Error, not an APIError —
  // the first RetriableStreamError payload that is not an SDK error object. The
  // recovery path must survive one, including the exhaustion branch that asks
  // getAssistantMessageFromError to render it.
  test('recovers from a mid-stream socket reset and reports it if it persists', async () => {
    process.env[RETRY_ENV] = '1'
    const socketReset = () =>
      new RetriableStreamError(
        Object.assign(
          new Error('The socket connection was closed unexpectedly.'),
          { code: 'ECONNRESET' },
        ),
      )

    let calls = 0
    const recovers = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        if (calls === 1) {
          yield { type: 'stream_event', event: { type: 'message_start' } }
          throw socketReset()
        }
        yield { type: 'assistant', message: { content: [] }, uuid: 'recovered' }
      })()

    const recovered = await collect(withStreamRetry(recovers, 'test-model', []))
    expect(calls).toBe(2)
    expect(recovered.at(-1)?.uuid).toBe('recovered')
    expect(recovered.some(m => m.isApiErrorMessage)).toBe(false)

    const persists = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        throw socketReset()
      })()

    const failed = await collect(withStreamRetry(persists, 'test-model', []))
    const last = failed.at(-1)
    expect(last?.type).toBe('assistant')
    expect(last?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('does not retry a non-RetriableStreamError; rethrows it', async () => {
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw new Error('fatal')
      })()

    await expect(
      collect(withStreamRetry(attempt, 'test-model', [])),
    ).rejects.toThrow('fatal')
    expect(calls).toBe(1)
  })

  test('maxRetries=0 makes a single attempt, then surfaces the error', async () => {
    process.env[RETRY_ENV] = '0'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw retriableError()
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(1)
    expect(out.at(-1)?.type).toBe('assistant')
    expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('yields completed text from only the final exhausted attempt', async () => {
    process.env[RETRY_ENV] = '1'
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        throw new RetriableStreamError(
          new Error('socket reset'),
          [
            {
              type: 'assistant',
              message: {
                id: `response-${calls}`,
                type: 'message',
                role: 'assistant',
                model: 'test-model',
                content: [{ type: 'text', text: `partial-${calls}` }],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                },
              },
              uuid: `partial-${calls}`,
              timestamp: new Date().toISOString(),
            },
          ],
        )
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))
    const partials = out.filter(
      message =>
        message.type === 'assistant' &&
        typeof message.uuid === 'string' &&
        message.uuid.startsWith('partial-'),
    )

    expect(calls).toBe(2)
    expect(partials.map(message => message.uuid)).toEqual(['partial-2'])
    expect(out.at(-1)?.isApiErrorMessage).toBe(true)
    delete process.env[RETRY_ENV]
  })

  test('passes through a clean attempt without retrying', async () => {
    let calls = 0
    const attempt = () =>
      // biome-ignore lint/suspicious/noExplicitAny: mock stream messages
      (async function* (): AsyncGenerator<any, void> {
        calls++
        yield { type: 'assistant', message: { content: [] }, uuid: 'clean' }
      })()

    const out = await collect(withStreamRetry(attempt, 'test-model', []))

    expect(calls).toBe(1)
    expect(out).toHaveLength(1)
    expect(out[0].uuid).toBe('clean')
  })
})
