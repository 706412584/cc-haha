import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  __persistCliTaskNotificationForTests,
  __resetWebSocketHandlerStateForTests,
} from '../ws/handler.js'
import { SessionService, sessionService } from '../services/sessionService.js'

describe('background task notification persistence', () => {
  let configDir = ''
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-task-notification-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    await fs.mkdir(path.join(configDir, 'projects'), { recursive: true })
  })

  afterEach(async () => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await fs.rm(configDir, { recursive: true, force: true })
  })

  it('restores a terminal Agent notification that was not forwarded into transcript history', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-background-agent')
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: '2026-07-18T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'agent-tool-1',
          name: 'Agent',
          input: { description: 'Verify background restore', run_in_background: true },
        }],
      },
    })}\n`, 'utf8')

    const service = new SessionService()
    await service.appendSessionTaskNotification(sessionId, {
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'completed',
      summary: 'Agent completed after the foreground Skill output',
      result: 'Background verification passed',
      timestamp: '2026-07-18T00:01:00.000Z',
    })

    expect(await service.getSessionTaskNotifications(sessionId)).toEqual([{
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'completed',
      summary: 'Agent completed after the foreground Skill output',
      result: 'Background verification passed',
      timestamp: '2026-07-18T00:01:00.000Z',
    }])
    expect(await fs.readFile(transcriptPath, 'utf8')).toContain('"type":"cc-haha-task-notification"')
  })

  it('keeps restoring legacy task-notification transcript turns', async () => {
    const sessionId = crypto.randomUUID()
    const projectDir = path.join(configDir, 'projects', '-tmp-legacy-notification')
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: '2026-07-17T00:00:00.000Z',
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>legacy-task</task-id>\n<tool-use-id>legacy-tool</tool-use-id>\n<status>completed</status>\n<summary>Legacy task completed</summary>\n</task-notification>',
      },
    })}\n`, 'utf8')

    const service = new SessionService()
    expect(await service.getSessionTaskNotifications(sessionId)).toEqual([{
      taskId: 'legacy-task',
      toolUseId: 'legacy-tool',
      status: 'completed',
      summary: 'Legacy task completed',
      timestamp: '2026-07-17T00:00:00.000Z',
    }])
  })

  it('normalizes and persists one terminal SDK event for multiple observers', async () => {
    const append = spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
    const sdkEvent = {
      type: 'system',
      subtype: 'task_notification',
      uuid: 'terminal-event-1',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      status: 'completed',
      summary: 'Agent completed',
      result: 'All checks passed',
      output_file: '/tmp/agent-task-1.output',
      timestamp: '2026-07-18T00:01:00.000Z',
    }

    const first = __persistCliTaskNotificationForTests('session-1', sdkEvent)
    const second = __persistCliTaskNotificationForTests('session-1', sdkEvent)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    await Promise.all([first, second])

    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith('session-1', {
      taskId: 'agent-task-1',
      toolUseId: 'agent-tool-1',
      status: 'completed',
      summary: 'Agent completed',
      result: 'All checks passed',
      outputFile: '/tmp/agent-task-1.output',
      timestamp: '2026-07-18T00:01:00.000Z',
    })
  })
})
