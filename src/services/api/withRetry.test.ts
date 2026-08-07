import { afterEach, describe, expect, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { _resetKeepAliveForTesting, getProxyFetchOptions } from '../../utils/proxy.js'
import {
  CannotRetryError,
  getMaxStreamTransientRetries,
  isRetryableStreamError,
  isRetryableStreamTransportError,
  RetriableStreamError,
  shouldRetryStreamAfterTransportDisconnect,
  withRetry,
} from './withRetry.js'

describe('withRetry stale connections', () => {
  test('disables keep-alive before retrying ECONNRESET connection failures', async () => {
    _resetKeepAliveForTesting()
    let attempts = 0
    const cause = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    })
    const staleConnection = new APIConnectionError({
      message: 'Connection error.',
      cause,
    })

    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        if (attempts === 1) {
          throw staleConnection
        }
        return 'ok'
      },
      {
        model: 'claude-opus-4-7',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 1,
      },
    )

    let finalValue: string | undefined
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        finalValue = next.value
        break
      }
    }

    expect(finalValue).toBe('ok')
    expect(attempts).toBe(2)
    expect(getProxyFetchOptions().keepalive).toBe(false)
    _resetKeepAliveForTesting()
  })
})

// --- Same-error suppression ---
//
// Background: every retry used to yield a SystemAPIErrorMessage to the
// chat as long as the error was an APIError. A flaky upstream that
// recovers in 1–2 retries painted the conversation with a wall of
// identical error bubbles. We now suppress consecutive identical errors
// until SAME_ERROR_REPORT_THRESHOLD (default 3) and yield distinct
// errors — and 429s — immediately.

function makeApiError(status: number, message: string): APIError {
  // Bypass the protected-constructor / generate path: the only thing the
  // limiter cares about is `instanceof APIError`, `.status`, `.message`.
  // Build a plain object that satisfies those checks.
  const err = new Error(message) as Error & {
    status?: number
    requestID?: string
  }
  err.name = 'APIError'
  err.status = status
  err.requestID = 'req-test'
  // Re-parent the prototype so `instanceof APIError` matches.
  Object.setPrototypeOf(err, APIError.prototype)
  return err as unknown as APIError
}

async function collectRetryYields(opts: {
  errorsBeforeOk: APIError[]
}): Promise<{ yielded: number; finalValue: string; attempts: number[] }> {
  let attempt = 0
  const generator = withRetry(
    async () => ({} as Anthropic),
    async () => {
      const err = opts.errorsBeforeOk[attempt]
      attempt += 1
      if (err) throw err
      return 'ok'
    },
    {
      model: 'claude-opus-4-7',
      thinkingConfig: { type: 'disabled' },
      maxRetries: opts.errorsBeforeOk.length,
    },
  )

  let yielded = 0
  let finalValue = ''
  const attempts: number[] = []
  for (;;) {
    const next = await generator.next()
    if (next.done) {
      finalValue = next.value
      break
    }
    yielded += 1
    if (typeof next.value.retryAttempt === 'number') {
      attempts.push(next.value.retryAttempt)
    }
  }
  return { yielded, finalValue, attempts }
}

describe('withRetry same-error suppression', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_RETRY_REPORT_AFTER
  })

  test('suppresses the first two identical 500 errors and reports the third', async () => {
    const err = makeApiError(500, 'Internal Server Error')
    // Three identical failures, then succeed on the 4th attempt.
    const result = await collectRetryYields({
      errorsBeforeOk: [err, err, err],
    })

    expect(result.finalValue).toBe('ok')
    // 1st error: new key, reported (1 yield)
    // 2nd identical: suppressed
    // 3rd identical: threshold (3) crossed, reported (1 yield)
    // Total: 2 yields, far less than the 3 the old code produced.
    expect(result.yielded).toBe(2)
  })

  test('a different error after a streak yields immediately on the new key', async () => {
    const e500 = makeApiError(500, 'Internal Server Error')
    const e503 = makeApiError(503, 'Service Unavailable')
    // 500, 500 (suppressed), 503 (NEW key, immediate), then ok.
    const result = await collectRetryYields({
      errorsBeforeOk: [e500, e500, e503],
    })

    expect(result.finalValue).toBe('ok')
    // 1st (500 new): yielded
    // 2nd (500 same): suppressed
    // 3rd (503 new): yielded
    expect(result.yielded).toBe(2)
  })

  test('CLAUDE_CODE_RETRY_REPORT_AFTER env override raises the threshold', async () => {
    process.env.CLAUDE_CODE_RETRY_REPORT_AFTER = '4'
    const err = makeApiError(500, 'Boom')
    // Three identical errors should ALL be suppressed because the
    // threshold is now 4; only the first (new-key bypass) yields.
    const result = await collectRetryYields({
      errorsBeforeOk: [err, err, err],
    })

    expect(result.finalValue).toBe('ok')
    expect(result.yielded).toBe(1) // only the first-sighting yield
  })

  // Desktop StreamingIndicator countdown + attempt badge only update when
  // each retry yields a SystemAPIErrorMessage. Suppressing identical 503s
  // left the UI stuck on "1/N" with a stale/expired delay ("正在重试…")
  // while later attempts were silent. Capacity/rate-limit errors always
  // carry wait-time info the user is watching, so report every attempt.
  test('always reports consecutive identical 503s so UI attempt/countdown can advance', async () => {
    const err = makeApiError(503, 'Service Unavailable')
    const result = await collectRetryYields({
      errorsBeforeOk: [err, err, err],
    })

    expect(result.finalValue).toBe('ok')
    expect(result.yielded).toBe(3)
    expect(result.attempts).toEqual([1, 2, 3])
  })

  test('always reports consecutive identical 429s so wait-time info stays fresh', async () => {
    const err = makeApiError(429, 'Rate limited')
    const result = await collectRetryYields({
      errorsBeforeOk: [err, err],
    })

    expect(result.finalValue).toBe('ok')
    expect(result.yielded).toBe(2)
    expect(result.attempts).toEqual([1, 2])
  })
})

describe('withRetry statusless transient API errors', () => {
  test('retries api_error during stream creation but does not retry deterministic 400 errors', async () => {
    const transientBody = {
      type: 'error',
      error: { type: 'api_error', message: 'Temporary upstream failure' },
    }
    const transient = new APIError(undefined, transientBody, JSON.stringify(transientBody), undefined)
    let transientAttempts = 0
    const transientGenerator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        transientAttempts += 1
        if (transientAttempts === 1) throw transient
        return 'recovered'
      },
      {
        model: 'claude-test',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 1,
      },
    )
    let recovered = ''
    for (;;) {
      const next = await transientGenerator.next()
      if (next.done) {
        recovered = next.value
        break
      }
    }
    expect(recovered).toBe('recovered')
    expect(transientAttempts).toBe(2)

    const deterministic = new APIError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad input' } },
      'bad input',
      undefined,
    )
    let deterministicAttempts = 0
    const deterministicGenerator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        deterministicAttempts += 1
        throw deterministic
      },
      {
        model: 'claude-test',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 2,
      },
    )
    await expect(deterministicGenerator.next()).rejects.toThrow('bad input')
    expect(deterministicAttempts).toBe(1)

    const typed400Body = {
      type: 'error',
      error: { type: 'api_error', message: 'deterministic gateway rejection' },
    }
    const typed400 = new APIError(400, typed400Body, JSON.stringify(typed400Body), undefined)
    let typed400Attempts = 0
    const typed400Generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        typed400Attempts += 1
        throw typed400
      },
      {
        model: 'claude-test',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 1,
      },
    )
    await expect(typed400Generator.next()).rejects.toThrow('deterministic gateway rejection')
    expect(typed400Attempts).toBe(1)
  })
})

describe('CannotRetryError retry metadata', () => {
  test('records the number of retries completed before a statusless api_error is exhausted', async () => {
    const body = { type: 'error', error: { type: 'api_error', message: 'temporary' } }
    const apiError = new APIError(undefined, body, JSON.stringify(body), undefined)
    Object.defineProperty(apiError, 'requestID', { value: 'req-create-final' })
    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => { throw apiError },
      {
        model: 'claude-test',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 2,
      },
    )
    try {
      for (;;) {
        const next = await generator.next()
        if (next.done) break
      }
      throw new Error('expected retry exhaustion')
    } catch (error) {
      expect(error).toBeInstanceOf(CannotRetryError)
      expect((error as CannotRetryError).retryCount).toBe(2)
      expect(((error as CannotRetryError).originalError as APIError).requestID).toBe('req-create-final')
    }
  })
})

describe('withRetry context overflow recovery', () => {
  test('uses the available context even when the thinking budget is larger', async () => {
    const overrides: Array<number | undefined> = []
    const overflowMessage =
      'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000'
    const overflow = new APIError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: overflowMessage,
        },
      },
      overflowMessage,
      undefined,
    )

    const generator = withRetry(
      async () => ({} as Anthropic),
      async (_client, attempt, context) => {
        overrides.push(context.maxTokensOverride)
        if (attempt === 1) {
          throw overflow
        }
        return 'ok'
      },
      {
        model: 'claude-opus-4-7',
        thinkingConfig: { type: 'enabled', budgetTokens: 20_000 },
        maxRetries: 1,
      },
    )

    let finalValue: string | undefined
    for (;;) {
      const next = await generator.next()
      if (next.done) {
        finalValue = next.value
        break
      }
    }

    expect(finalValue).toBe('ok')
    expect(overrides).toEqual([undefined, 9_000])
  })

  test('stops when the provider repeats the same overflow after adjustment', async () => {
    let attempts = 0
    const overflowMessage =
      'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000'
    const overflow = new APIError(
      400,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: overflowMessage,
        },
      },
      overflowMessage,
      undefined,
    )

    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        throw overflow
      },
      {
        model: 'claude-opus-4-7',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 5,
      },
    )

    let thrown: unknown
    try {
      while (!(await generator.next()).done) {
        // Drain retry status messages until the generator terminates.
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBe(overflow)
    expect((thrown as CannotRetryError).retryContext.maxTokensOverride).toBe(
      9_000,
    )
    expect(attempts).toBe(2)
  })
})

describe('context overflow wrapped in 401 (#1162)', () => {
  test('does not retry when a gateway reports overflow as a 401', async () => {
    let attempts = 0
    const message = 'k3-256k supports only 256K context.'
    const overflow401 = new APIError(
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message },
      },
      message,
      undefined,
    )

    const generator = withRetry(
      async () => ({} as Anthropic),
      async () => {
        attempts += 1
        throw overflow401
      },
      {
        model: 'k3-256k',
        thinkingConfig: { type: 'disabled' },
        maxRetries: 5,
      },
    )

    let thrown: unknown
    try {
      while (!(await generator.next()).done) {
        // Drain retry status messages until the generator terminates.
      }
    } catch (error) {
      thrown = error
    }

    // Retrying replays the same oversized prompt — it must fail fast instead
    // of burning through 10 attempts against an unrecoverable rejection.
    expect(thrown).toBeInstanceOf(CannotRetryError)
    expect((thrown as CannotRetryError).originalError).toBe(overflow401)
    expect(attempts).toBe(1)
  })
})

describe('isRetryableStreamError', () => {
  // The SDK embeds the serialized error body in `error.message`; mirror that so
  // the matcher sees the same shape it does in production.
  function apiErrorWithBody(body: object, status?: number): APIError {
    return new APIError(status, body, JSON.stringify(body), undefined)
  }

  test('matches a mid-stream api_error with no HTTP status', () => {
    const err = apiErrorWithBody({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Failed to generate a valid tool call.',
      },
    })
    expect(isRetryableStreamError(err)).toBe(true)
  })

  test('matches Grok stream disconnects serialized as a plain API Error message', () => {
    const err = new Error(
      'API Error: {"error":{"message":"OpenAI messages stream disconnected before completion","type":"api_error"},"type":"error"}',
    )
    expect(isRetryableStreamError(err)).toBe(true)
  })

  test('matches an overloaded_error', () => {
    const err = apiErrorWithBody({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    })
    expect(isRetryableStreamError(err)).toBe(true)
  })

  test('matches a temporarily unavailable upstream_error', () => {
    const err = apiErrorWithBody({
      error: {
        message: 'Upstream service temporarily unavailable',
        type: 'upstream_error',
      },
      type: 'error',
    })
    expect(isRetryableStreamError(err)).toBe(true)
  })

  test('matches an upstream_error nested by a compatibility gateway', () => {
    const err = apiErrorWithBody({
      error: {
        error: {
          type: 'upstream_error',
        },
      },
      type: 'error',
    })
    expect(isRetryableStreamError(err)).toBe(true)
  })

  test('does not match a client invalid_request_error', () => {
    const err = apiErrorWithBody(
      {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad input' },
      },
      400,
    )
    expect(isRetryableStreamError(err)).toBe(false)
  })

  test.each([400, 401, 403, 404, 422])('does not retry an explicit %i api_error', status => {
    const err = apiErrorWithBody({
      type: 'error',
      error: { type: 'api_error', message: 'deterministic client failure' },
    }, status)
    expect(isRetryableStreamError(err)).toBe(false)
  })

  test.each([
    'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    'fetch failed: ECONNRESET',
    'socket hang up',
  ])('matches a transient connection failure during stream consumption: %s', message => {
    const cause = new Error(message)
    if (message.includes('ECONNRESET')) {
      ;(cause as NodeJS.ErrnoException).code = 'ECONNRESET'
    }
    const err = new APIConnectionError({ cause })
    expect(isRetryableStreamError(err)).toBe(true)
  })

  test('does not match an arbitrary non-API error', () => {
    expect(
      isRetryableStreamError(new Error('Failed to generate a valid tool call.')),
    ).toBe(false)
  })

  test('does not match an APIError whose message lacks the markers', () => {
    const err = new APIError(
      500,
      { error: { type: 'internal', message: 'x' } },
      'Internal Server Error',
      undefined,
    )
    expect(isRetryableStreamError(err)).toBe(false)
  })

  test('does not match a retryable type string embedded only in user-facing text', () => {
    const err = apiErrorWithBody({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'User text contained {"type":"upstream_error"}',
      },
    })
    expect(isRetryableStreamError(err)).toBe(false)
  })
})

describe('isRetryableStreamTransportError', () => {
  /**
   * The exact object Bun's fetch throws when the peer resets a connection whose
   * response body is still being read. Captured from a raw TCP server that sent
   * chunked SSE headers plus one event, then terminated the socket.
   */
  function bunMidStreamReset(): Error {
    return Object.assign(
      new Error(
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      ),
      { code: 'ECONNRESET' },
    )
  }

  test("matches Bun's bare mid-stream socket reset", () => {
    expect(isRetryableStreamTransportError(bunMidStreamReset())).toBe(true)
  })

  test('matches every transport code, wherever it sits in the cause chain', () => {
    for (const code of [
      'ECONNRESET',
      'ECONNABORTED',
      'EPIPE',
      'UND_ERR_SOCKET',
      'ERR_STREAM_PREMATURE_CLOSE',
    ]) {
      const cause = Object.assign(new Error('socket hang up'), { code })
      expect(isRetryableStreamTransportError(cause)).toBe(true)
      expect(
        isRetryableStreamTransportError(
          new APIConnectionError({ message: 'Connection error.', cause }),
        ),
      ).toBe(true)
    }
  })

  test('does not match faults a re-send cannot clear', () => {
    expect(isRetryableStreamTransportError(new Error('boom'))).toBe(false)
    expect(isRetryableStreamTransportError(undefined)).toBe(false)
    expect(
      isRetryableStreamTransportError(
        Object.assign(new Error('bad certificate'), {
          code: 'CERT_HAS_EXPIRED',
        }),
      ),
    ).toBe(false)
    expect(
      isRetryableStreamTransportError(
        new APIError(
          500,
          { error: { type: 'internal', message: 'x' } },
          'Internal Server Error',
          undefined,
        ),
      ),
    ).toBe(false)
  })
})

describe('shouldRetryStreamAfterTransportDisconnect', () => {
  const disconnect = Object.assign(new Error('socket closed'), {
    code: 'ECONNRESET',
  })
  const clean = {
    error: disconnect,
    hasCrossedSideEffectBoundary: false,
    streamIdleAborted: false,
    signalAborted: false,
  }

  test('recovers a disconnect while the attempt is still side-effect-free', () => {
    expect(shouldRetryStreamAfterTransportDisconnect(clean)).toBe(true)
  })

  test('refuses once a tool block completed — a re-send would run it twice', () => {
    expect(
      shouldRetryStreamAfterTransportDisconnect({
        ...clean,
        hasCrossedSideEffectBoundary: true,
      }),
    ).toBe(false)
  })

  test('leaves watchdog aborts to their own retry path', () => {
    expect(
      shouldRetryStreamAfterTransportDisconnect({
        ...clean,
        streamIdleAborted: true,
      }),
    ).toBe(false)
  })

  test('never fights a user abort', () => {
    expect(
      shouldRetryStreamAfterTransportDisconnect({
        ...clean,
        signalAborted: true,
      }),
    ).toBe(false)
  })

  test('ignores non-transport stream errors', () => {
    expect(
      shouldRetryStreamAfterTransportDisconnect({
        ...clean,
        error: new Error('Stream ended without receiving any events'),
      }),
    ).toBe(false)
  })
})

describe('getMaxStreamTransientRetries', () => {
  const ENV = 'CLAUDE_STREAM_TRANSIENT_RETRY_MAX'

  test('defaults to 4 when unset so transient stream failures get a meaningful recovery window', () => {
    delete process.env[ENV]
    expect(getMaxStreamTransientRetries()).toBe(4)
  })

  test('honors a numeric override (including 0 to disable)', () => {
    process.env[ENV] = '5'
    expect(getMaxStreamTransientRetries()).toBe(5)
    process.env[ENV] = '0'
    expect(getMaxStreamTransientRetries()).toBe(0)
    delete process.env[ENV]
  })

  test('falls back to default 4 on non-numeric input', () => {
    process.env[ENV] = 'abc'
    expect(getMaxStreamTransientRetries()).toBe(4)
    delete process.env[ENV]
  })
})

describe('RetriableStreamError', () => {
  test('carries the original error and a faithful message', () => {
    const original = new Error('boom')
    const wrapped = new RetriableStreamError(original)
    expect(wrapped.originalError).toBe(original)
    expect(wrapped.name).toBe('RetriableStreamError')
    expect(wrapped.message).toContain('boom')
  })
})
