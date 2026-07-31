import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { deserializeMessages } from './conversationRecovery.js'
import { normalizeMessagesForAPI } from './messages.js'

describe('deserializeMessages malformed attachments', () => {
  test.each([
    ['missing payload', { type: 'attachment' }],
    ['null payload', { type: 'attachment', attachment: null }],
    [
      'invalid hook context',
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          content: null,
        },
      },
    ],
    [
      'new-file attachment with a non-string filename',
      {
        type: 'attachment',
        attachment: { type: 'new_file', filename: null },
      },
    ],
    [
      'new-directory attachment with a non-string path',
      {
        type: 'attachment',
        attachment: { type: 'new_directory', path: null },
      },
    ],
    [
      'current file attachment with a non-string filename',
      {
        type: 'attachment',
        attachment: { type: 'file', filename: 42 },
      },
    ],
    [
      'current directory attachment with a non-string path',
      {
        type: 'attachment',
        attachment: { type: 'directory', path: 42 },
      },
    ],
    [
      'IDE selection with non-string content',
      {
        type: 'attachment',
        attachment: {
          type: 'selected_lines_in_ide',
          content: null,
        },
      },
    ],
    [
      'invoked-skills attachment with a non-array payload',
      {
        type: 'attachment',
        attachment: { type: 'invoked_skills', skills: null },
      },
    ],
    [
      'hook-success attachment with a non-string payload',
      {
        type: 'attachment',
        attachment: { type: 'hook_success', content: null },
      },
    ],
    [
      'skill-listing attachment with a non-string payload',
      {
        type: 'attachment',
        attachment: { type: 'skill_listing', content: null },
      },
    ],
    [
      'deferred-tools delta without rendered lines',
      {
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['Read'],
          removedNames: [],
        },
      },
    ],
    [
      'MCP instructions delta without rendered blocks',
      {
        type: 'attachment',
        attachment: {
          type: 'mcp_instructions_delta',
          addedNames: ['server'],
          removedNames: [],
        },
      },
    ],
    [
      'agent-listing delta without rendered lines',
      {
        type: 'attachment',
        attachment: {
          type: 'agent_listing_delta',
          addedTypes: ['Explore'],
          removedTypes: [],
        },
      },
    ],
  ])('drops a %s instead of crashing resume', (_name, malformed) => {
    const messages = deserializeMessages([
      malformed as unknown as Message,
    ])

    expect(messages).toEqual([])
  })

  test('keeps non-attachment messages and unknown forward-compatible attachments', () => {
    const messages = deserializeMessages([
      {
        type: 'system',
        subtype: 'local_command',
        content: 'status',
        level: 'info',
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      } as Message,
      {
        type: 'attachment',
        attachment: { type: 'future_attachment' },
      } as unknown as Message,
    ])

    expect(
      messages.some(
        message =>
          message.type === 'system' && message.content === 'status',
      ),
    ).toBe(true)
    expect(
      messages.some(
        message =>
          message.type === 'attachment' &&
          (message.attachment as { type: string }).type ===
            'future_attachment',
      ),
    ).toBe(true)
  })

  test('drops a malformed known attachment at API normalization', () => {
    const malformed = {
      type: 'attachment',
      attachment: {
        type: 'todo_reminder',
        content: null,
        itemCount: 0,
      },
    } as unknown as Message

    expect(normalizeMessagesForAPI([malformed])).toEqual([])
  })

  test('drops a missing attachment envelope at API normalization', () => {
    expect(
      normalizeMessagesForAPI([
        { type: 'attachment' } as unknown as Message,
      ]),
    ).toEqual([])
  })
})
