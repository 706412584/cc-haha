import { describe, expect, test } from 'bun:test'
import {
  parseFrontmatter,
  splitPathInFrontmatter,
} from './frontmatterParser.js'

describe('parseFrontmatter delimiters', () => {
  test('keeps indented delimiter text inside YAML block scalars', () => {
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

    expect(frontmatter).toMatchObject({
      name: 'restricted-reviewer',
      description:
        'Reviews security boundaries.\n---\nKeep this delimiter in the description.\n',
      model: 'haiku',
      permissionMode: 'plan',
      tools: [],
    })
    expect(content).toBe('Only inspect the requested files.')
  })

  test('accepts CRLF delimiters with trailing horizontal whitespace', () => {
    const markdown = [
      '--- \t',
      'name: compatible-agent',
      'description: Compatible frontmatter',
      'tools: []',
      '---\t ',
      '',
      'Keep the body intact.',
    ].join('\r\n')

    const { frontmatter, content } = parseFrontmatter(markdown)

    expect(frontmatter).toMatchObject({
      name: 'compatible-agent',
      description: 'Compatible frontmatter',
      tools: [],
    })
    expect(content).toBe('Keep the body intact.')
  })
})

describe('splitPathInFrontmatter brace expansion', () => {
  test('keeps an exponentially large pattern unexpanded', () => {
    const pattern = Array.from({ length: 11 }, () => '{a,b}').join('/')

    expect(splitPathInFrontmatter(pattern)).toEqual([pattern])
  })

  test('shares the expansion budget across comma-separated patterns', () => {
    const pattern = Array.from({ length: 9 }, () => '{a,b}').join('/')
    const expanded = splitPathInFrontmatter([pattern, pattern, pattern])

    expect(expanded).toHaveLength(514)
    expect(expanded.slice(-2)).toEqual([pattern, pattern])
  })
})
