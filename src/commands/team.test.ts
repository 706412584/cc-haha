import { describe, expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-key'

const { builtInCommandNames } = await import('../commands.js')
const { default: teamCommand } = await import('./team.js')

describe('/team command', () => {
  test('is registered as a built-in slash command', () => {
    expect(builtInCommandNames().has('team')).toBe(true)
  })

  test('is enabled by the Agent Teams project opt-in', () => {
    const previous = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    try {
      expect(teamCommand.isEnabled?.()).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
      } else {
        process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = previous
      }
    }
  })

  test('turns an empty invocation into actionable help instead of a silent turn', async () => {
    await expect(teamCommand.getPromptForCommand('', {} as never)).resolves.toEqual([
      {
        type: 'text',
        text: expect.stringContaining('/team <goal>'),
      },
    ])
  })

  test('preserves the requested goal and directs the model through TeamCreate', async () => {
    const [prompt] = await teamCommand.getPromptForCommand(
      'audit authentication and fix the highest-risk issue',
      {} as never,
    )

    expect(prompt?.type).toBe('text')
    expect(prompt && 'text' in prompt ? prompt.text : '').toContain(
      'audit authentication and fix the highest-risk issue',
    )
    expect(prompt && 'text' in prompt ? prompt.text : '').toContain('TeamCreate')
  })
})
