import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { getVerificationGateState } from './attachments.js'
import { createAssistantMessage } from './messages.js'

/**
 * Build an assistant message containing a single tool_use block.
 * Mimics the shape produced by the real assistant turn pipeline well
 * enough for the gate's history-walking logic, which only inspects
 * `m.type`, `m.message.content[*].type`, `block.name`, and `block.input`.
 */
function assistantWithToolUse(
  toolName: string,
  toolInput: Record<string, unknown> = {},
): Message {
  return createAssistantMessage({
    content: [
      {
        type: 'tool_use',
        id: `toolu_${toolName}_${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        input: toolInput,
      },
    ],
  }) as Message
}

describe('getVerificationGateState', () => {
  test('returns 0 edits and no reminder for empty history', () => {
    const result = getVerificationGateState([])
    expect(result.editsSinceVerification).toBe(0)
    expect(result.reminderAlreadyFired).toBe(false)
  })

  test('counts Edit tool uses', () => {
    const messages: Message[] = [
      assistantWithToolUse('Edit', { file_path: '/a.ts' }),
      assistantWithToolUse('Edit', { file_path: '/b.ts' }),
      assistantWithToolUse('Edit', { file_path: '/c.ts' }),
    ]
    const result = getVerificationGateState(messages)
    expect(result.editsSinceVerification).toBe(3)
    expect(result.reminderAlreadyFired).toBe(false)
  })

  test('counts Write and NotebookEdit alongside Edit', () => {
    const messages: Message[] = [
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Write'),
      assistantWithToolUse('NotebookEdit'),
    ]
    const result = getVerificationGateState(messages)
    expect(result.editsSinceVerification).toBe(3)
  })

  test('ignores read-only tools', () => {
    const messages: Message[] = [
      assistantWithToolUse('Read'),
      assistantWithToolUse('Grep'),
      assistantWithToolUse('Bash'),
      assistantWithToolUse('Edit'),
    ]
    const result = getVerificationGateState(messages)
    expect(result.editsSinceVerification).toBe(1)
  })

  test('verification subagent invocation resets the counter', () => {
    const messages: Message[] = [
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Edit'),
      // Verification was invoked here — edits before it are now "verified"
      assistantWithToolUse('Agent', { subagent_type: 'verification' }),
      // Edits after verification accumulate again
      assistantWithToolUse('Edit'),
    ]
    const result = getVerificationGateState(messages)
    expect(result.editsSinceVerification).toBe(1)
    expect(result.reminderAlreadyFired).toBe(false)
  })

  test('Task tool with subagent_type=verification also resets (legacy alias)', () => {
    const messages: Message[] = [
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Task', { subagent_type: 'verification' }),
      assistantWithToolUse('Edit'),
    ]
    const result = getVerificationGateState(messages)
    expect(result.editsSinceVerification).toBe(1)
  })

  test('non-verification subagent calls do NOT reset the counter', () => {
    const messages: Message[] = [
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Agent', { subagent_type: 'code-reviewer' }),
      assistantWithToolUse('Edit'),
    ]
    const result = getVerificationGateState(messages)
    expect(result.editsSinceVerification).toBe(3)
  })

  test('detects a previously fired reminder since the last reset point', () => {
    const reminderMessage: Message = {
      type: 'attachment',
      attachment: {
        type: 'verification_gate_reminder',
        editCount: 3,
        threshold: 3,
      },
      uuid: 'reminder-uuid',
      timestamp: new Date().toISOString(),
    } as unknown as Message
    const messages: Message[] = [
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Edit'),
      assistantWithToolUse('Edit'),
      reminderMessage,
      assistantWithToolUse('Edit'),
    ]
    const result = getVerificationGateState(messages)
    expect(result.editsSinceVerification).toBe(4)
    expect(result.reminderAlreadyFired).toBe(true)
  })

  test('ignores a reminder that fired BEFORE a verification reset', () => {
    const reminderMessage: Message = {
      type: 'attachment',
      attachment: {
        type: 'verification_gate_reminder',
        editCount: 3,
        threshold: 3,
      },
      uuid: 'reminder-uuid',
      timestamp: new Date().toISOString(),
    } as unknown as Message
    const messages: Message[] = [
      assistantWithToolUse('Edit'),
      reminderMessage,
      assistantWithToolUse('Edit'),
      // Verification ran — slate is wiped, prior reminder is irrelevant
      assistantWithToolUse('Agent', { subagent_type: 'verification' }),
      assistantWithToolUse('Edit'),
    ]
    const result = getVerificationGateState(messages)
    expect(result.editsSinceVerification).toBe(1)
    expect(result.reminderAlreadyFired).toBe(false)
  })

  test('handles assistant messages with multiple tool_use blocks in one turn', () => {
    const multi: Message = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_a',
          name: 'Edit',
          input: { file_path: '/a.ts' },
        },
        {
          type: 'tool_use',
          id: 'toolu_b',
          name: 'Edit',
          input: { file_path: '/b.ts' },
        },
        {
          type: 'tool_use',
          id: 'toolu_c',
          name: 'Read',
          input: { file_path: '/c.ts' },
        },
      ],
    }) as Message
    const result = getVerificationGateState([multi])
    expect(result.editsSinceVerification).toBe(2)
  })
})
