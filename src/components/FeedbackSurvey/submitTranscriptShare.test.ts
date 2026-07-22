import { describe, expect, test } from 'bun:test'

import {
  filterMessagesForTranscriptShare,
  filterRawTranscriptForShare,
} from './submitTranscriptShare.js'

describe('transcript attachment privacy', () => {
  test('removes locally persisted attachment content from normalized sharing input', () => {
    const messages = [
      {
        type: 'user',
        uuid: '11111111-1111-4111-8111-111111111111',
        message: { role: 'user', content: 'summarize the attachment' },
      },
      {
        type: 'attachment',
        uuid: '22222222-2222-4222-8222-222222222222',
        attachment: {
          type: 'file',
          filename: '/workspace/private.md',
          content: {
            type: 'text',
            file: { content: 'private attachment canary' },
          },
        },
      },
    ] as never[]

    expect(filterMessagesForTranscriptShare(messages)).toEqual([messages[0]])
  })

  test('removes attachment records from raw JSONL while preserving other and malformed lines', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { content: 'keep me' } }),
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'file', content: 'private attachment canary' },
      }),
      'legacy malformed line',
    ].join('\n')

    const filtered = filterRawTranscriptForShare(raw)
    expect(filtered).toContain('keep me')
    expect(filtered).toContain('legacy malformed line')
    expect(filtered).not.toContain('private attachment canary')
  })
})
