import { describe, expect, test } from 'bun:test'
import {
  SDKTaskNotificationMessageSchema,
  SDKTaskProgressMessageSchema,
  SDKTaskStartedMessageSchema,
} from './coreSchemas.js'

const identity = {
  owner_agent_id: 'parent-agent',
  uuid: 'event-uuid',
  session_id: 'root-session',
}

describe('SDK task ownership schemas', () => {
  test('preserves an owning agent across start, progress, and terminal events', () => {
    const started = SDKTaskStartedMessageSchema().parse({
      type: 'system',
      subtype: 'task_started',
      task_id: 'nested-agent',
      tool_use_id: 'nested-agent-tool',
      description: 'Nested work',
      task_type: 'local_agent',
      ...identity,
    })
    const progress = SDKTaskProgressMessageSchema().parse({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'nested-agent',
      tool_use_id: 'nested-agent-tool',
      description: 'Nested work',
      usage: { total_tokens: 12, tool_uses: 2, duration_ms: 50 },
      ...identity,
    })
    const terminal = SDKTaskNotificationMessageSchema().parse({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'nested-agent',
      tool_use_id: 'nested-agent-tool',
      status: 'completed',
      output_file: '/tmp/nested-agent.output',
      summary: 'Nested work complete',
      ...identity,
    })

    expect(started.owner_agent_id).toBe('parent-agent')
    expect(progress.owner_agent_id).toBe('parent-agent')
    expect(terminal.owner_agent_id).toBe('parent-agent')
  })
})
