import { describe, it, expect } from 'vitest'
import { splitFrontmatter, toFrontmatterEntries } from './skillFrontmatter'

describe('splitFrontmatter', () => {
  it('splits a SKILL.md frontmatter block off the body', () => {
    const md = ['---', 'name: find-skills', 'slug: guipi-find-skills', '---', '', '# Heading', 'body text'].join('\n')

    const { frontmatter, body } = splitFrontmatter(md)

    expect(frontmatter).toEqual({ name: 'find-skills', slug: 'guipi-find-skills' })
    expect(body).toBe('# Heading\nbody text')
  })

  it('keeps quoted versions as strings so 1.7.0 does not become a number', () => {
    const { frontmatter } = splitFrontmatter('---\nversion: "1.7.0"\nweight: 3\n---\n')

    expect(frontmatter).toEqual({ version: '1.7.0', weight: 3 })
  })

  it('parses inline sequences, including quoted items containing commas', () => {
    const md = '---\nxiaping_tags: ["AI工具","技能发现","a, b"]\n---\n'

    expect(splitFrontmatter(md).frontmatter).toEqual({ xiaping_tags: ['AI工具', '技能发现', 'a, b'] })
  })

  it('parses block sequences', () => {
    const md = ['---', 'paths:', '  - src/**', '  - tests/**', 'model: opus', '---', 'body'].join('\n')

    expect(splitFrontmatter(md).frontmatter).toEqual({ paths: ['src/**', 'tests/**'], model: 'opus' })
  })

  it('parses booleans and nulls', () => {
    const { frontmatter } = splitFrontmatter('---\nagent_created: true\nuser-invocable: false\nagent: null\n---\n')

    expect(frontmatter).toEqual({ agent_created: true, 'user-invocable': false, agent: null })
  })

  it('keeps literal block scalars line-broken and folds folded ones', () => {
    const md = ['---', 'literal: |', '  line one', '  line two', 'folded: >', '  line one', '  line two', '---'].join('\n')

    expect(splitFrontmatter(md).frontmatter).toEqual({
      literal: 'line one\nline two',
      folded: 'line one line two',
    })
  })

  it('keeps nested mappings as raw YAML instead of dropping them', () => {
    const md = ['---', 'hooks:', '  PreToolUse:', '    - matcher: Bash', 'model: opus', '---'].join('\n')

    const { frontmatter } = splitFrontmatter(md)

    expect(frontmatter?.model).toBe('opus')
    expect(frontmatter?.hooks).toBe('PreToolUse:\n  - matcher: Bash')
  })

  it('ignores a colon inside a description value', () => {
    const md = '---\ndescription: Use this when: you want X\n---\nbody'

    expect(splitFrontmatter(md).frontmatter).toEqual({ description: 'Use this when: you want X' })
  })

  it('strips trailing comments but leaves # inside quotes alone', () => {
    const { frontmatter } = splitFrontmatter('---\nmodel: opus # the good one\ntag: "a#b"\n---\n')

    expect(frontmatter).toEqual({ model: 'opus', tag: 'a#b' })
  })

  it('returns the document untouched when there is no frontmatter', () => {
    const md = '# Just a doc\n\nwith --- inside\n'

    expect(splitFrontmatter(md)).toEqual({ frontmatter: null, body: md })
  })

  it('does not eat the document when the fence is never closed', () => {
    const md = '---\nname: broken\n\n# Heading'

    expect(splitFrontmatter(md)).toEqual({ frontmatter: null, body: md })
  })

  it('treats a leading horizontal rule as body, not as an open fence', () => {
    const md = '---\n\n# Heading\n\nsome text\n'

    expect(splitFrontmatter(md).frontmatter).toBeNull()
  })

  it('tolerates CRLF line endings', () => {
    const { frontmatter, body } = splitFrontmatter('---\r\nname: crlf\r\n---\r\n# Heading\r\n')

    expect(frontmatter).toEqual({ name: 'crlf' })
    expect(body).toBe('# Heading\r\n')
  })

  it('handles an empty document', () => {
    expect(splitFrontmatter('')).toEqual({ frontmatter: null, body: '' })
  })

  it('drops an empty frontmatter block from the body without reporting metadata', () => {
    expect(splitFrontmatter('---\n---\n# Heading')).toEqual({ frontmatter: null, body: '# Heading' })
  })
})

describe('toFrontmatterEntries', () => {
  it('hides keys the detail header already shows', () => {
    const entries = toFrontmatterEntries({
      name: 'find-skills',
      displayName: 'Find Skills',
      description: 'long text',
      version: '1.7.0',
      model: 'opus',
    })

    expect(entries.map((e) => e.key)).toEqual(['model'])
  })

  it('drops empty values', () => {
    const entries = toFrontmatterEntries({ a: '', b: '   ', c: null, d: [], e: 'kept', f: false })

    expect(entries.map((e) => e.key)).toEqual(['e', 'f'])
  })

  it('sorts well-known operational keys first, then alphabetically', () => {
    const entries = toFrontmatterEntries({ zeta: '1', 'allowed-tools': 'Read', alpha: '2', model: 'opus' })

    expect(entries.map((e) => e.key)).toEqual(['allowed-tools', 'model', 'alpha', 'zeta'])
  })

  it('flags long and multi-line strings as block values', () => {
    const entries = toFrontmatterEntries({
      short: 'opus',
      long: 'x'.repeat(60),
      multiline: 'a\nb',
    })

    expect(entries.find((e) => e.key === 'short')?.block).toBe(false)
    expect(entries.find((e) => e.key === 'long')?.block).toBe(true)
    expect(entries.find((e) => e.key === 'multiline')?.block).toBe(true)
  })

  it('renders nested objects from a server-side YAML parse as pretty JSON', () => {
    const entries = toFrontmatterEntries({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } })

    expect(entries[0]?.value).toContain('"PreToolUse"')
    expect(entries[0]?.block).toBe(true)
  })

  it('honours caller-supplied skip keys case-insensitively', () => {
    const entries = toFrontmatterEntries({ slug: 'a', model: 'opus' }, { skipKeys: ['SLUG'] })

    expect(entries.map((e) => e.key)).toEqual(['model'])
  })

  it('returns nothing for null or empty frontmatter', () => {
    expect(toFrontmatterEntries(null)).toEqual([])
    expect(toFrontmatterEntries({})).toEqual([])
  })
})
