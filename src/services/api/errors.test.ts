import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import {
  categorizeRetryableAPIError,
  getAssistantMessageFromError,
  getImageUnsupportedErrorMessage,
  isContextWindowExceededMessage,
  isUnsupportedImageInputErrorMessage,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from './errors.js'

describe('image unsupported API errors', () => {
  test('detects provider-specific text-only model image rejections', () => {
    const unsupportedImageErrors = [
      'This model does not support image blocks',
      'unsupported modality: image input is not available',
      'Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text` at line 1 column 394097',
      "Invalid value for 'messages[0].content[1].type': 'image_url' is not one of ['text']",
      "messages.0.content.1.type: Input should be 'text'; received 'image_url'",
      'image_url content parts are not allowed for this model',
    ]

    for (const message of unsupportedImageErrors) {
      expect(isUnsupportedImageInputErrorMessage(message)).toBe(true)
    }
    expect(isUnsupportedImageInputErrorMessage('image exceeds maximum')).toBe(false)
  })

  test('maps unsupported image rejections to a recoverable synthetic error', () => {
    const msg = getAssistantMessageFromError(
      new Error('This model does not support image blocks'),
      'mimo-v2.5-pro',
    )

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED)
    expect(msg.errorDetails).toBe('This model does not support image blocks')
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: getImageUnsupportedErrorMessage(),
    })
  })
})

describe('retried API error metadata', () => {
  test('adds the bounded retry count and request ID to the final user-visible error', () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    try {
      const body = { type: 'error', error: { type: 'api_error', message: 'temporary' } }
      const error = new APIError(undefined, body, JSON.stringify(body), undefined)
      const message = getAssistantMessageFromError(error, 'claude-test', {
        retryCount: 2,
        requestId: 'req-create-final',
      })
      expect(message.message.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Retried 2 times.'),
      })
      expect(message.requestId).toBe('req-create-final')
      expect(String(message.errorDetails ?? '')).not.toContain('req-create-final')
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previousApiKey
    }
  })
})

describe('temporary upstream API errors', () => {
  test('keeps the raw upstream payload in diagnostics but shows a retryable message', () => {
    const body = {
      error: {
        message: 'Upstream service temporarily unavailable',
        type: 'upstream_error',
      },
      type: 'error',
    }
    const error = new APIError(
      undefined,
      body,
      JSON.stringify(body),
      undefined,
    )

    const message = getAssistantMessageFromError(error, 'gpt-5.6-sol')

    expect(message.isApiErrorMessage).toBe(true)
    expect(message.error).toBe('server_error')
    expect(message.message.content[0]).toMatchObject({
      type: 'text',
      text: 'API Error: Upstream service is temporarily unavailable. Please try again.',
    })
    expect(message.errorDetails).toContain('"type":"upstream_error"')
    expect(categorizeRetryableAPIError(error)).toBe('server_error')
  })
})

describe('context-window-overflow relay errors', () => {
  test('detects third-party relay context-overflow wording', () => {
    const overflowErrors = [
      'API Error: 400 {"error":{"type":"context_too_large","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}',
      'Your input exceeds the context window of this model.',
      'context_too_large',
      'This model maximum context length exceeded. Please reduce your prompt.',
    ]
    for (const message of overflowErrors) {
      expect(isContextWindowExceededMessage(message)).toBe(true)
    }
    expect(isContextWindowExceededMessage('prompt is too long')).toBe(false)
    expect(isContextWindowExceededMessage('some unrelated 400 error')).toBe(false)
  })

  test('maps relay context_too_large to the prompt-too-long handling', () => {
    const raw =
      'API Error: 400 {"error":{"type":"context_too_large","message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}'
    const msg = getAssistantMessageFromError(new Error(raw), 'gpt-5.5')

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.PROMPT_TOO_LONG)
    // Reuses the canonical content string so the TUI/desktop render the
    // actionable "Context limit reached · /compact or /clear" guidance.
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: PROMPT_TOO_LONG_ERROR_MESSAGE,
    })
    expect(msg.errorDetails).toBe(raw)
  })
})
