import { beforeEach, describe, expect, mock, test } from 'bun:test'
import teamCommand from '../../commands/team.js'
import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { createAssistantMessage } from '../messages.js'

process.env.ANTHROPIC_API_KEY = 'test-key'

const { default: agentCommand } = await import('../../commands/agent.js')

const runAgentMock = mock(() =>
  (async function* () {
    yield createAssistantMessage({ content: 'debugger result' })
  })(),
)

mock.module('../../tools/AgentTool/runAgent.js', () => ({
  runAgent: runAgentMock,
}))

const { processSlashCommand } = await import('./processSlashCommand.js')

const makeAgent = (agentType: string): AgentDefinition => ({
  agentType,
  whenToUse: `Use ${agentType}`,
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => `${agentType} prompt`,
})

function makeContext(
  activeAgents: AgentDefinition[],
  commands: Command[] = [agentCommand],
): ToolUseContext {
  return {
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      kairosEnabled: false,
      mcp: { clients: [] },
      toolPermissionContext: {
        alwaysAllowRules: { command: [] },
      },
    }),
    setResponseLength: () => {},
    options: {
      commands,
      tools: [],
      agentDefinitions: { activeAgents },
    },
  } as unknown as ToolUseContext
}

function metaPromptText(result: Awaited<ReturnType<typeof processSlashCommand>>): string {
  const metaPrompt = result.messages.find(
    message => message.type === 'user' && message.isMeta,
  )
  return Array.isArray(metaPrompt?.message.content)
    ? metaPrompt.message.content
        .map(block => ('text' in block ? block.text : ''))
        .join('\n')
    : ''
}

describe('/agent slash command processing', () => {
  beforeEach(() => {
    runAgentMock.mockClear()
  })

  test('routes the selected agent through the normal chat loop', async () => {
    const result = await processSlashCommand(
      '/agent debugger fix failing tests',
      [],
      [],
      [],
      makeContext([makeAgent('general-purpose'), makeAgent('debugger')]),
      () => {},
    )

    expect(result.shouldQuery).toBe(true)
    expect(runAgentMock.mock.calls.length).toBe(0)

    expect(
      result.messages.some(
        message =>
          message.type === 'user' &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('<local-command-stdout>'),
      ),
    ).toBe(false)

    const metaPrompt = result.messages.find(
      message => message.type === 'user' && message.isMeta,
    )
    const metaPromptText = Array.isArray(metaPrompt?.message.content)
      ? metaPrompt.message.content
          .map(block => ('text' in block ? block.text : ''))
          .join('\n')
      : ''
    expect(metaPromptText).toContain('subagent_type "debugger"')
    expect(metaPromptText).toContain('fix failing tests')
  })

  test('shows usage when the agent prompt is missing', async () => {
    const result = await processSlashCommand(
      '/agent debugger',
      [],
      [],
      [],
      makeContext([makeAgent('general-purpose'), makeAgent('debugger')]),
      () => {},
    )

    expect(result.shouldQuery).toBe(false)
    expect(runAgentMock.mock.calls.length).toBe(0)
    expect(
      result.messages.some(
        message => message.message.content === 'Usage: /agent <agent> <prompt>',
      ),
    ).toBe(true)
  })

})

describe('/team slash command processing', () => {
  test('queries the model with actionable help for an exact /team invocation', async () => {
    const result = await processSlashCommand(
      '/team',
      [],
      [],
      [],
      makeContext([], [teamCommand]),
      () => {},
    )

    expect(result.shouldQuery).toBe(true)
    expect(metaPromptText(result)).toContain('/team <goal>')
    expect(
      result.messages.some(
        message =>
          message.type === 'user' &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('<local-command-stdout>'),
      ),
    ).toBe(false)
  })

  test('carries the exact goal and structured team tools into the normal turn', async () => {
    const result = await processSlashCommand(
      '/team audit authentication and fix the highest-risk issue',
      [],
      [],
      [],
      makeContext([], [teamCommand]),
      () => {},
    )

    expect(result.shouldQuery).toBe(true)
    expect(metaPromptText(result)).toContain('audit authentication and fix the highest-risk issue')
    expect(metaPromptText(result)).toContain('TeamCreate')
    expect(result.allowedTools).toEqual(expect.arrayContaining([
      'TeamCreate',
      'TaskCreate',
      'TaskUpdate',
      'Agent',
      'SendMessage',
    ]))
  })
})
