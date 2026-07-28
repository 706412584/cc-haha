import { describe, expect, test } from 'bun:test'
import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import { getImageUnsupportedErrorMessage } from '../../services/api/errors.js'
import { roughTokenCountEstimationForAPIRequest } from '../../services/tokenEstimation.js'
import type { UserMessage } from '../../types/message.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from '../messages.js'

const imageBlock = (data: string) => ({
  type: 'image' as const,
  source: {
    type: 'base64' as const,
    media_type: 'image/png' as const,
    data,
  },
})

describe('media error recovery', () => {
  test('strips images after an unsupported-image model error', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'describe this screenshot' },
        imageBlock('base64-image-payload'),
        { type: 'text', text: '[Image source: /tmp/screenshot.png]' },
      ],
      uuid: '00000000-0000-4000-8000-000000000001',
    })
    const unsupported = createAssistantAPIErrorMessage({
      content: getImageUnsupportedErrorMessage(),
      error: 'invalid_request',
    })
    const nextUser = createUserMessage({
      content: 'continue with text only',
      uuid: '00000000-0000-4000-8000-000000000002',
    })

    const normalized = normalizeMessagesForAPI([imageUser, unsupported, nextUser])
    const serialized = JSON.stringify(normalized)

    expect(serialized).not.toContain('base64-image-payload')
    expect(serialized).toContain('describe this screenshot')
    expect(serialized).toContain('continue with text only')
  })

  test('strips images using stable business error codes', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'describe this screenshot' },
        imageBlock('base64-image-payload'),
      ],
      uuid: '00000000-0000-4000-8000-000000000003',
    })
    const unsupported = createAssistantAPIErrorMessage({
      content: 'localized display text',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED,
    })
    const nextUser = createUserMessage({
      content: 'continue with text only',
      uuid: '00000000-0000-4000-8000-000000000004',
    })

    const normalized = normalizeMessagesForAPI([imageUser, unsupported, nextUser])
    const serialized = JSON.stringify(normalized)

    expect(serialized).not.toContain('base64-image-payload')
    expect(serialized).toContain('describe this screenshot')
    expect(serialized).toContain('continue with text only')
  })

  test('recovers legacy invalid-image API errors without a business error code', () => {
    const toolResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'legacy-corrupt-image',
          content: [imageBlock('legacy-corrupt-image-data')],
        },
      ],
      uuid: '00000000-0000-4000-8000-000000000005',
    })
    const legacyError = createAssistantAPIErrorMessage({
      content:
        'API Error: 400 {"error":{"message":"Invalid PNG image.","type":"invalid_request_error"},"type":"error"}\n\nRetried 0 times.',
      error: 'unknown',
    })
    const nextUser = createUserMessage({
      content: 'continue after upgrading',
      uuid: '00000000-0000-4000-8000-000000000006',
    })

    const serialized = JSON.stringify(
      normalizeMessagesForAPI([toolResult, legacyError, nextUser]),
    )

    expect(serialized).not.toContain('legacy-corrupt-image-data')
    expect(serialized).toContain('continue after upgrading')
  })

  test('strips an invalid image nested inside a tool result on the next turn', () => {
    const toolResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read-corrupt-image',
          content: [imageBlock('corrupt-nested-image')],
        },
      ],
      uuid: '00000000-0000-4000-8000-000000000005',
    })
    const laterToolResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'another-read',
          content: 'another image could not be resized',
          is_error: true,
        },
      ],
      uuid: '00000000-0000-4000-8000-000000000006',
    })
    const invalid = createAssistantAPIErrorMessage({
      content: 'localized invalid image text',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_INVALID,
    })
    const nextUser = createUserMessage({
      content: 'continue with text only',
      uuid: '00000000-0000-4000-8000-000000000007',
    })

    const normalized = normalizeMessagesForAPI([
      toolResult,
      laterToolResult,
      invalid,
      nextUser,
    ])
    const serialized = JSON.stringify(normalized)

    expect(serialized).not.toContain('corrupt-nested-image')
    expect(serialized).toContain('[media removed after API rejection]')
    expect(serialized).toContain('read-corrupt-image')
    expect(serialized).toContain('continue with text only')
  })

  test('merges repeated media rejections for the same historical image', () => {
    const imageUser = createUserMessage({
      content: [
        { type: 'text', text: 'inspect this image' },
        imageBlock('repeated-rejection-image'),
      ],
      uuid: '00000000-0000-4000-8000-000000000008',
    })
    const unsupported = createAssistantAPIErrorMessage({
      content: 'unsupported image',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_UNSUPPORTED,
    })
    const invalid = createAssistantAPIErrorMessage({
      content: 'invalid image',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_INVALID,
    })
    const nextUser = createUserMessage({
      content: 'continue without it',
      uuid: '00000000-0000-4000-8000-000000000009',
    })

    const serialized = JSON.stringify(
      normalizeMessagesForAPI([imageUser, unsupported, invalid, nextUser]),
    )

    expect(serialized).not.toContain('repeated-rejection-image')
    expect(serialized).toContain('continue without it')
  })

  test('strips every candidate image when an invalid-image error does not identify which one failed', () => {
    const corruptToolResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read-corrupt-image',
          content: [imageBlock('corrupt-earlier-image')],
        },
      ],
      uuid: '00000000-0000-4000-8000-000000000008',
    })
    const laterImageResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read-later-image',
          content: [imageBlock('later-image')],
        },
      ],
      uuid: '00000000-0000-4000-8000-000000000009',
    })
    const invalid = createAssistantAPIErrorMessage({
      content: 'localized invalid image text',
      error: 'invalid_request',
      businessErrorCode: BUSINESS_ERROR_CODES.IMAGE_INVALID,
    })
    const nextUser = createUserMessage({
      content: 'continue without rejected media',
      uuid: '00000000-0000-4000-8000-000000000010',
    })

    const serialized = JSON.stringify(
      normalizeMessagesForAPI([
        corruptToolResult,
        laterImageResult,
        invalid,
        nextUser,
      ]),
    )

    expect(serialized).not.toContain('corrupt-earlier-image')
    expect(serialized).not.toContain('"data":"later-image"')
    expect(serialized).toContain('read-corrupt-image')
    expect(serialized).toContain('read-later-image')
    expect(serialized).toContain('continue without rejected media')
  })
})

describe('media context estimation', () => {
  test('does not count base64 image bytes as text tokens', () => {
    const rawBase64 = 'a'.repeat(1_000_000)
    const tokens = roughTokenCountEstimationForAPIRequest(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this image?' },
            imageBlock(rawBase64),
          ] as UserMessage['message']['content'],
        },
      ],
      [],
    )

    expect(tokens).toBeGreaterThanOrEqual(2_000)
    expect(tokens).toBeLessThan(3_000)
  })
})
