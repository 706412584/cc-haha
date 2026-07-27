import { describe, expect, test } from 'bun:test'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { parseAgentFromMarkdown } from './loadAgentsDir.js'

describe('Markdown agent frontmatter boundaries', () => {
  test('preserves an empty tool allowlist after an indented block-scalar delimiter', () => {
    const markdown = [
      '---',
      'name: restricted-reviewer',
      'description: |',
      '  Reviews security boundaries.',
      '  ---',
      '  Keep this delimiter in the description.',
      'model: haiku',
      'permissionMode: plan',
      'tools: []',
      '---',
      'Only inspect the requested files.',
    ].join('\n')
    const { frontmatter, content } = parseFrontmatter(markdown)

    const agent = parseAgentFromMarkdown(
      '/tmp/restricted-reviewer.md',
      '/tmp',
      frontmatter,
      content,
      'projectSettings',
    )

    expect(agent).not.toBeNull()
    expect(agent?.rawTools).toEqual([])
    expect(agent?.tools).toEqual([])
    expect(agent?.model).toBe('haiku')
    expect(agent?.permissionMode).toBe('plan')
    expect(agent?.rawSystemPrompt).toBe('Only inspect the requested files.')
  })

  test('preserves persisted tools when a wildcard grants runtime access', () => {
    const markdown = [
      '---',
      'name: wildcard-reviewer',
      'description: Reviews with an explicit wildcard and custom rules.',
      'tools:',
      '  - Read',
      '  - "*"',
      '  - Bash(git:*)',
      '  - Agent(worker, researcher)',
      '  - mcp__qa__search',
      '---',
      'Review the requested files.',
    ].join('\n')
    const { frontmatter, content } = parseFrontmatter(markdown)

    const agent = parseAgentFromMarkdown(
      '/tmp/wildcard-reviewer.md',
      '/tmp',
      frontmatter,
      content,
      'userSettings',
    )

    expect(agent).not.toBeNull()
    expect(agent?.rawTools).toEqual([
      'Read',
      '*',
      'Bash(git:*)',
      'Agent(worker, researcher)',
      'mcp__qa__search',
    ])
    expect(agent?.tools).toBeUndefined()
  })
})
