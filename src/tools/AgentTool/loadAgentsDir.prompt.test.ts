import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parseAgentFromJson, parseAgentFromMarkdown } from './loadAgentsDir.js'

let originalDisableAutoMemory: string | undefined

describe('custom agent raw system prompt', () => {
  beforeEach(() => {
    originalDisableAutoMemory = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
  })

  afterEach(() => {
    if (originalDisableAutoMemory === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
    } else {
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = originalDisableAutoMemory
    }
  })

  test('JSON agent keeps raw prompt separate from runtime memory prompt', () => {
    const rawPrompt = 'Keep this JSON prompt editable.'
    const agent = parseAgentFromJson('json-memory-agent', {
      description: 'JSON memory agent',
      prompt: rawPrompt,
      memory: 'project',
    })

    expect(agent?.rawSystemPrompt).toBe(rawPrompt)
    expect(agent?.getSystemPrompt()).toStartWith(`${rawPrompt}\n\n`)
    expect(agent?.getSystemPrompt()).not.toBe(rawPrompt)
  })

  test('Markdown agent keeps raw prompt separate from runtime memory prompt', () => {
    const rawPrompt = 'Keep this Markdown prompt editable.'
    const agent = parseAgentFromMarkdown(
      '/tmp/markdown-memory-agent.md',
      '/tmp',
      {
        name: 'markdown-memory-agent',
        description: 'Markdown memory agent',
        memory: 'project',
        tools: ['Bash'],
      },
      `\n${rawPrompt}\n`,
      'projectSettings',
    )

    expect(agent?.rawSystemPrompt).toBe(rawPrompt)
    expect(agent?.rawTools).toEqual(['Bash'])
    expect(agent?.tools).toEqual(['Bash', 'Write', 'Edit', 'Read'])
    expect(agent?.getSystemPrompt()).toStartWith(`${rawPrompt}\n\n`)
    expect(agent?.getSystemPrompt()).not.toBe(rawPrompt)
  })

  test('Markdown agent records an omitted tools field before runtime expansion', () => {
    const agent = parseAgentFromMarkdown(
      '/tmp/markdown-all-tools-agent.md',
      '/tmp',
      {
        name: 'markdown-all-tools-agent',
        description: 'Markdown all-tools agent',
        memory: 'project',
      },
      'Use all available tools.',
      'projectSettings',
    )

    expect(Object.hasOwn(agent ?? {}, 'rawTools')).toBe(true)
    expect(agent?.rawTools).toBeUndefined()
    expect(agent?.tools).toBeUndefined()
  })
})
