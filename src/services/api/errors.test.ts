import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import {
  getAssistantMessageFromError,
  getImageUnsupportedErrorMessage,
  isContextOverflowErrorText,
  isSerializedSizeOverflowText,
  isUnsupportedImageInputErrorMessage,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from './errors.js'

describe('invalid image API errors', () => {
  test('maps malformed image rejections to a recoverable synthetic error', () => {
    for (const format of ['PNG', 'JPEG', 'WebP', 'GIF']) {
      const body = {
        error: {
          message: `Invalid ${format} image.`,
          type: 'invalid_request_error',
        },
        type: 'error',
      }
      const msg = getAssistantMessageFromError(
        new APIError(400, body, JSON.stringify(body), undefined),
        'claude-test',
      )

      expect(msg.isApiErrorMessage).toBe(true)
      expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.IMAGE_INVALID)
      expect(msg.errorDetails).toContain(`Invalid ${format} image.`)
    }
  })
})

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
    expect(msg.sourceModel).toBe('mimo-v2.5-pro')
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: getImageUnsupportedErrorMessage(),
    })
  })

  test('falls back to image_unsupported when a 400 with unrecognized wording hit a request carrying images', () => {
    const message = 'unsupported content block type: only text is allowed for this model'
    const error = new APIError(
      400,
      {
        type: 'error',
        error: { type: 'invalid_request_error', message },
      },
      message,
      undefined,
    )
    const messagesForAPI = [
      {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            { type: 'text', text: 'look at this' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
            },
          ],
        },
      },
    ]

    // The wording alone must not match the text classifier, otherwise this
    // test stops exercising the request-context fallback.
    expect(isUnsupportedImageInputErrorMessage(message)).toBe(false)

    const msg = getAssistantMessageFromError(error, 'deepseek-v4-pro', {
      messagesForAPI: messagesForAPI as never,
    })

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED)
    expect(msg.sourceModel).toBe('deepseek-v4-pro')
  })

  test('does not fall back to image_unsupported when the failed request carried no images', () => {
    const message = 'unsupported content block type: only text is allowed for this model'
    const error = new APIError(
      400,
      {
        type: 'error',
        error: { type: 'invalid_request_error', message },
      },
      message,
      undefined,
    )
    const messagesForAPI = [
      {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'plain text only' },
      },
    ]

    const msg = getAssistantMessageFromError(error, 'deepseek-v4-pro', {
      messagesForAPI: messagesForAPI as never,
    })

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBeUndefined()
  })

  test('does not fall back for non-400/422 API errors even when images were sent', () => {
    const error = new APIError(
      500,
      {
        type: 'error',
        error: { type: 'api_error', message: 'internal error' },
      },
      'internal error',
      undefined,
    )
    const messagesForAPI = [
      {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
            },
          ],
        },
      },
    ]

    const msg = getAssistantMessageFromError(error, 'deepseek-v4-pro', {
      messagesForAPI: messagesForAPI as never,
    })

    expect(msg.businessErrorCode).toBeUndefined()
  })
})

describe('context overflow errors', () => {
  test('matches provider-specific overflow wordings', () => {
    const overflowMessages = [
      'prompt is too long: 137500 tokens > 135000 maximum',
      'Prompt is too long',
      'input is too long for requested model',
      "This model's maximum context length is 262144 tokens",
      'context_length_exceeded',
      '401 {"error":{"type":"authentication_error","message":"k3-256k supports only 256K context."}}',
      'Request exceeds the context window of this model',
      // GLM relay bigmodel channel hard cap (observed 2026-09-10)
      'Input token exceed the limit (request id: 2026091012232219399237c955d568bTYJlzPo)',
      // Zhipu standard API 400001 (multi-channel relay roulette)
      'The request is invalid: Prompt exceeds max length. Please check the request body, required fields, and request format. (request id: 2026091013121410808462c955d568YOqobsug)',
    ]

    for (const message of overflowMessages) {
      expect(isContextOverflowErrorText(message)).toBe(true)
    }
  })

  // Serialized-size rejections are a separate family: same symptom (a request
  // too large to send) but a different fix, chosen by status. The wording was
  // observed on a relay that reported ~90K tokens against a declared 1M window,
  // so no token-based pattern matched and the error fell through to the
  // image-rejection fallback — reporting "This model does not support images"
  // for a request that was merely too large.
  test('recognises the serialized-size wording the token patterns miss', () => {
    const serializedSizeMessages = [
      '400 {"error":{"type":"<nil>","message":"{\\"message\\":\\"Input content length exceeds threshold.\\",\\"reason\\":\\"CONTENT_LENGTH_EXCEEDS_THRESHOLD\\"} (request id: 202609181612512662043798268d9d64lkDAC4q)"}}',
      'Input content length exceeds threshold.',
      'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
    ]

    for (const message of serializedSizeMessages) {
      expect(isSerializedSizeOverflowText(message)).toBe(true)
    }

    // Attachment limits are not request overflow: the file itself is too big, so
    // there is nothing to compact.
    expect(isSerializedSizeOverflowText('The uploaded file content length exceeds the 10MB limit')).toBe(false)
  })

  test('does not match unrelated or separately-handled errors', () => {
    const negatives = [
      'Invalid API key',
      'OAuth token has been revoked',
      'This model does not support image blocks',
      // Handled by the max_tokens adjustment retry path, not the PTL path.
      'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000',
      // Attachment size limits, not request overflow: compacting cannot shrink
      // them, and the image-stripping fallback does handle them.
      'The uploaded file content length exceeds the 10MB limit',
      'Invalid request: maximum content length exceeds the allowed limit for this model',
    ]

    for (const message of negatives) {
      expect(isContextOverflowErrorText(message)).toBe(false)
    }
  })

  test('maps a 401-wrapped overflow to Prompt is too long, not a login prompt (#1162)', () => {
    const message = 'k3-256k supports only 256K context.'
    const error = new APIError(
      401,
      {
        type: 'error',
        error: { type: 'authentication_error', message },
      },
      message,
      undefined,
    )

    const msg = getAssistantMessageFromError(error, 'k3-256k')

    expect(msg.isApiErrorMessage).toBe(true)
    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.PROMPT_TOO_LONG)
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: PROMPT_TOO_LONG_ERROR_MESSAGE,
    })
  })

  test('maps GLM relay 400 overflow wordings to Prompt is too long so reactive compact can recover', () => {
    const observedErrors = [
      'Input token exceed the limit (request id: 2026091012232219399237c955d568bTYJlzPo)',
      'The request is invalid: Prompt exceeds max length. Please check the request body, required fields, and request format. (request id: 2026091013121410808462c955d568YOqobsug)',
    ]

    for (const message of observedErrors) {
      const error = new APIError(
        400,
        {
          type: 'error',
          error: { type: 'api_error', message },
        },
        message,
        undefined,
      )

      const msg = getAssistantMessageFromError(error, 'glm-5.3-flash')

      expect(msg.isApiErrorMessage).toBe(true)
      expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.PROMPT_TOO_LONG)
      expect(msg.message.content[0]).toMatchObject({
        type: 'text',
        text: PROMPT_TOO_LONG_ERROR_MESSAGE,
      })
    }
  })

  // Regression: a serialized-size rejection that arrives on a request carrying
  // image blocks used to hit the generic image-rejection fallback, because no
  // overflow pattern matched "content length". The user saw "This model does
  // not support images" for an oversized request, and the session could never
  // recover: image stripping does not shrink the payload that caused it.
  test('does not report a content-length rejection as unsupported images when the request carried images', () => {
    const message =
      '400 {"error":{"type":"<nil>","message":"{\\"message\\":\\"Input content length exceeds threshold.\\",\\"reason\\":\\"CONTENT_LENGTH_EXCEEDS_THRESHOLD\\"}"}}'
    const error = new APIError(
      400,
      { type: 'error', error: { type: 'api_error', message } },
      message,
      undefined,
    )
    const messagesForAPI = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tool-1',
            content: [
              { type: 'text' as const, text: 'preview' },
              {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: 'image/png' as const,
                  data: 'aGVsbG8=',
                },
              },
            ],
          },
        ],
      },
    ]

    const msg = getAssistantMessageFromError(error, 'claude-opus-4-8', {
      messagesForAPI,
    })

    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.PROMPT_TOO_LONG)
    expect(msg.message.content[0]).toMatchObject({
      type: 'text',
      text: PROMPT_TOO_LONG_ERROR_MESSAGE,
    })
  })

  // The image-rejection fallback strips images. A request that also carries a
  // document must be classified so the document is stripped too — otherwise the
  // oversized document replays on every turn, the same unrecoverable loop the
  // fallback exists to break.
  test('strips documents too when the unrecognized rejection carried one', () => {
    const message = '400 something the classifier does not recognise'
    const error = new APIError(
      400,
      { type: 'error', error: { type: 'api_error', message } },
      message,
      undefined,
    )
    const messagesForAPI = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tool-1',
            content: [
              { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' } },
              { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: 'aGVsbG8=' } },
            ],
          },
        ],
      },
    ]

    const msg = getAssistantMessageFromError(error, 'claude-opus-4-8', { messagesForAPI })

    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.REQUEST_TOO_LARGE)
  })

  test('keeps the image classification when no document is present', () => {
    const message = '400 something the classifier does not recognise'
    const error = new APIError(
      400,
      { type: 'error', error: { type: 'api_error', message } },
      message,
      undefined,
    )
    const messagesForAPI = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'tool-1',
            content: [
              { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' } },
            ],
          },
        ],
      },
    ]

    const msg = getAssistantMessageFromError(error, 'claude-opus-4-8', { messagesForAPI })

    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED)
  })

  // A 413 says the payload itself is unacceptable, which the media-stripping
  // path fixes. Compacting instead would shrink the transcript around a document
  // that is itself too large, and the next turn would resend it — the exact
  // unrecoverable loop the overflow classifier exists to avoid.
  test('routes a 413 with the serialized-size wording to the media path, not to compact', () => {
    const message = '{"message":"Input content length exceeds threshold.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}'
    const error = new APIError(
      413,
      { type: 'error', error: { type: 'api_error', message } },
      message,
      undefined,
    )

    const msg = getAssistantMessageFromError(error, 'claude-opus-4-8')

    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.REQUEST_TOO_LARGE)
  })

  // The same wording without a 413 status is a transcript overflow: there is no
  // attachment to strip, so compacting is the only recovery.
  test('routes the serialized-size wording without a 413 to compact', () => {
    const message = '{"message":"Input content length exceeds threshold.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}'
    const error = new APIError(
      400,
      { type: 'error', error: { type: 'api_error', message } },
      message,
      undefined,
    )

    const msg = getAssistantMessageFromError(error, 'claude-opus-4-8')

    expect(msg.businessErrorCode).toBe(BUSINESS_ERROR_CODES.PROMPT_TOO_LONG)
  })
})
