import { describe, expect, test } from 'bun:test'
import { getCliBackgroundTaskLifecycle } from './agentTaskState.js'

describe('getCliBackgroundTaskLifecycle ownership', () => {
  test('keeps root task ownership implicit', () => {
    expect(getCliBackgroundTaskLifecycle({
      type: 'system',
      subtype: 'task_started',
      task_id: 'root-agent',
      task_type: 'local_agent',
    })).toEqual({
      taskId: 'root-agent',
      running: true,
      taskType: 'local_agent',
      toolUseId: undefined,
      remoteSessionId: undefined,
      description: undefined,
      ownerAgentId: undefined,
    })
  })

  test('carries nested ownership from start through terminal lifecycle', () => {
    expect(getCliBackgroundTaskLifecycle({
      type: 'system',
      subtype: 'task_started',
      task_id: 'nested-agent',
      task_type: 'local_agent',
      owner_agent_id: 'parent-agent',
    })).toEqual(expect.objectContaining({
      taskId: 'nested-agent',
      running: true,
      ownerAgentId: 'parent-agent',
    }))

    expect(getCliBackgroundTaskLifecycle({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'nested-agent',
      status: 'completed',
      owner_agent_id: 'parent-agent',
    })).toEqual({
      taskId: 'nested-agent',
      running: false,
      status: 'completed',
      ownerAgentId: 'parent-agent',
    })
  })
})
