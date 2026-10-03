import { describe, expect, it } from 'vitest'

import { detectCapabilities, extractTriggers, readingMinutes } from './skillInsights'

// Ported from dsh-skills-hub `tests/skill-insights.test.mjs`.

describe('detectCapabilities', () => {
  it('cites its evidence: scripts, commands, hooks, writes', () => {
    const markdown = [
      '# Self-Improvement',
      '```bash',
      'mkdir -p .learnings',
      '[ -f .learnings/LEARNINGS.md ] || printf "# Learnings" > .learnings/LEARNINGS.md',
      '```',
      'Optionally copy the hook to ~/.openclaw/hooks and restart the gateway.',
    ].join('\n')
    const found = detectCapabilities({
      markdown,
      files: [
        { path: 'SKILL.md' },
        { path: 'scripts/extract-skill.sh' },
        { path: 'scripts/tests/extract.test.sh' },
        { path: 'hooks/openclaw/handler.js' },
        { path: 'hooks/openclaw/handler.test.js' },
      ],
    })
    const byKind = Object.fromEntries(found.map((capability) => [capability.kind, capability]))

    // One entry script plus the commands it runs; hook handlers are their own finding.
    expect(byKind.shell?.evidence).toEqual(['scripts/extract-skill.sh', 'mkdir', 'printf'])
    expect(byKind.shell?.level).toBe('high')
    expect(byKind.hooks?.evidence).toEqual(['hooks/', '~/.openclaw/hooks'])
    expect(byKind.writes?.evidence).toEqual(['.learnings/'])
  })

  it('reports declared requirements, secrets and called hosts, but not doc links', () => {
    const found = detectCapabilities({
      markdown: 'Set `TAVILY_API_KEY`.\n```js\nfetch("https://api.tavily.com/search")\n// see https://github.com/x/y\n```',
      frontmatter: { metadata: '{"clawdbot":{"requires":{"bins":["git"],"env":["GH_TOKEN"]}}}' },
      files: [{ path: 'SKILL.md' }],
    })
    const byKind = Object.fromEntries(found.map((capability) => [capability.kind, capability.evidence]))

    expect(byKind.binaries).toEqual(['git'])
    expect(byKind.secrets).toEqual(['GH_TOKEN', 'TAVILY_API_KEY'])
    expect(byKind.network).toEqual(['api.tavily.com'])
  })

  it('makes no capability claims at all for a plain prose skill', () => {
    // An empty "nothing risky" verdict is a claim the rules cannot back.
    expect(detectCapabilities({ markdown: '# Writing guide\nBe concise.', files: [{ path: 'SKILL.md' }] })).toEqual([])
  })

  it('orders findings by risk, highest first', () => {
    const found = detectCapabilities({
      markdown: '```bash\nmkdir -p out\ncurl https://api.example.org/v1\n```\nNeeds `OPENAI_API_KEY`.',
      files: [{ path: 'SKILL.md' }, { path: 'hooks/pre.js' }],
    })
    expect(found.map((capability) => capability.kind)).toEqual(['shell', 'hooks', 'secrets', 'network', 'writes'])
  })
})

describe('extractTriggers', () => {
  it('reads "Use when (1)… (2)…" and Chinese 当…时 phrasing', () => {
    expect(
      extractTriggers('Captures learnings. Use when: (1) A command fails unexpectedly, (2) User corrects Claude, (3) An external API fails'),
    ).toEqual(['A command fails unexpectedly', 'User corrects Claude', 'An external API fails'])
    expect(extractTriggers('当用户需要查询医药政策、解读政策影响时使用')).toEqual(['用户需要查询医药政策', '解读政策影响'])
  })

  it('returns nothing for a description without a trigger clause', () => {
    expect(extractTriggers('A plain description.')).toEqual([])
    expect(extractTriggers(undefined)).toEqual([])
  })
})

describe('readingMinutes', () => {
  it('counts CJK characters and Latin words', () => {
    expect(readingMinutes('word '.repeat(440))).toBe(2)
    expect(readingMinutes('字'.repeat(800))).toBe(2)
    expect(readingMinutes('')).toBe(1)
  })
})
