import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getSubagentRunByTool,
  resolveSubagentRunFromMessages,
  truncateSubagentMessages,
} from './subagentRunService.js'
import type { MessageEntry } from './sessionService.js'

let tmpDir: string | null = null

async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(os.tmpdir(), `subagent-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  return tmpDir
}

async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  if (!tmpDir) throw new Error('tmpDir not initialized')
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  )
}

async function writeSubagentTranscriptFile(
  projectDir: string,
  sessionId: string,
  agentId: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  if (!tmpDir) throw new Error('tmpDir not initialized')
  const dir = path.join(tmpDir, 'projects', projectDir, sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
  await fs.writeFile(
    path.join(dir, `${normalizedAgentId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf-8',
  )
}

function makeAgentToolUseEntry(toolUseId: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: { description: 'Explore repo', prompt: 'Read files' },
      }],
    },
    uuid: 'assistant-agent-use',
    timestamp: '2026-01-01T00:00:01.000Z',
  }
}

function makeAgentToolResultEntry(toolUseId: string, agentId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{
          type: 'text',
          text: `Finished exploring the repo\nagentId: ${agentId}\n<usage>input_tokens: 7\noutput_tokens: 11\ntotal_tokens: 18</usage>`,
        }],
      }],
    },
    uuid: 'user-agent-result',
    timestamp: '2026-01-01T00:00:03.000Z',
  }
}

describe('subagentRunService helpers', () => {
  it('resolves agentId, description, and prompt from parent Agent messages by toolUseId', () => {
    const messages = [
      {
        id: 'assistant-agent-use',
        type: 'tool_use',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'Agent',
          input: { description: 'Explore repo', prompt: 'Read files' },
        }],
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'user-agent-result',
        type: 'tool_result',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: [{ type: 'text', text: 'agentId: abc123\nStarted' }],
        }],
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ] as MessageEntry[]

    expect(resolveSubagentRunFromMessages(messages, 'tool-1')).toMatchObject({
      agentId: 'abc123',
      description: 'Explore repo',
      prompt: 'Read files',
    })
  })

  it('does not truncate transcripts with at most 1000 messages', () => {
    const messages = Array.from({ length: 1000 }, (_, index) => ({ id: String(index) }))

    const result = truncateSubagentMessages(messages)

    expect(result).toEqual({ messages, truncated: false })
  })

  it('truncates long transcripts to first 50 and latest 950 entries', () => {
    const messages = Array.from({ length: 1200 }, (_, index) => ({ id: String(index) }))

    const result = truncateSubagentMessages(messages)

    expect(result.truncated).toBe(true)
    expect(result.messages).toHaveLength(1000)
    expect(result.messages[0]).toEqual({ id: '0' })
    expect(result.messages[49]).toEqual({ id: '49' })
    expect(result.messages[50]).toEqual({ id: '250' })
    expect(result.messages[999]).toEqual({ id: '1199' })
  })
})

describe('getSubagentRunByTool', () => {
  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('returns parent metadata and visible persisted subagent transcript messages', async () => {
    await setupTmpConfigDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      makeAgentToolResultEntry(toolUseId, agentId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>tool-1</tool-use-id>\n<status>completed</status>\n<summary>Agent completed</summary>\n<result>Finished exploring the repo</result>\n<output-file>/tmp/agent.out</output-file>\n</task-notification>',
        },
        uuid: 'task-notification',
        timestamp: '2026-01-01T00:00:04.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Read the source' },
        uuid: 'subagent-user',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Found the service seam' }],
          usage: { input_tokens: 13, output_tokens: 17 },
        },
        uuid: 'subagent-assistant',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result).toMatchObject({
      sessionId,
      toolUseId,
      agentId,
      taskId: 'task-1',
      status: 'completed',
      description: 'Explore repo',
      prompt: 'Read files',
      summary: 'Agent completed',
      result: 'Finished exploring the repo',
      outputFile: '/tmp/agent.out',
      usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 },
      truncated: false,
      updatedAt: '2026-01-01T00:00:06.000Z',
      source: 'subagent-jsonl',
    })
    expect(result?.messages).toHaveLength(2)
    expect(result?.messages[0]).toMatchObject({
      type: 'user',
      content: 'Read the source',
      isSidechain: undefined,
    })
    expect(result?.messages[1]).toMatchObject({
      type: 'assistant',
      content: [{ type: 'text', text: 'Found the service seam' }],
      usage: { input_tokens: 13, output_tokens: 17 },
    })
  })

  it('does not report usage when parent and transcript usage are unknown', async () => {
    await setupTmpConfigDir()
    const sessionId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `Finished exploring the repo\nagentId: ${agentId}`,
          }],
        },
        uuid: 'user-agent-result-without-usage',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'user',
        message: { role: 'user', content: 'Read the source' },
        uuid: 'subagent-user',
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Found the service seam' }],
        },
        uuid: 'subagent-assistant',
        timestamp: '2026-01-01T00:00:06.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result?.usage).toBeUndefined()
  })

  it('marks parent Agent tool errors as failed when no task notification overrides them', async () => {
    await setupTmpConfigDir()
    const sessionId = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-subagent-run'
    const toolUseId = 'tool-1'

    await writeSessionFile(projectDir, sessionId, [
      makeAgentToolUseEntry(toolUseId),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: "Agent type 'general' not found",
            is_error: true,
          }],
        },
        uuid: 'user-agent-error-result',
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])

    const result = await getSubagentRunByTool(sessionId, toolUseId)

    expect(result).toMatchObject({
      sessionId,
      toolUseId,
      status: 'failed',
      result: "Agent type 'general' not found",
      source: 'session-history',
    })
  })

  it('returns null when the parent Agent tool use is not present', async () => {
    await setupTmpConfigDir()
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-subagent-run', sessionId, [
      makeAgentToolResultEntry('tool-1', 'abc123'),
    ])

    await expect(getSubagentRunByTool(sessionId, 'tool-1')).resolves.toBeNull()
  })
})
