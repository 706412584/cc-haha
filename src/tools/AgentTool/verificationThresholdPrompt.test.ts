import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

function loadSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

describe('verification agent triggering guidance', () => {
  test('Agent tool examples do not delegate tests solely because code was written', () => {
    const source = loadSource('src/tools/AgentTool/prompt.ts')

    expect(source).not.toContain('Since a significant piece of code was written')
    expect(source).toContain('run focused checks directly')
    expect(source).toContain('high-risk cross-boundary change')
  })

  test('generated agent examples require independent verification value', () => {
    const source = loadSource('src/components/agents/generateAgent.ts')

    expect(source).not.toContain('after a logical chunk of code is written')
    expect(source).not.toContain('Since a significant piece of code was written')
    expect(source).toContain('independent verification of complex or high-risk changes')
  })

  test('session guidance makes the main agent responsible for direct checks', () => {
    const source = loadSource('src/constants/prompts.ts')

    expect(source).toContain('You own basic verification')
    expect(source).toContain('Small, localized changes normally stop there')
    expect(source).toContain('Do not invoke verification solely because code was written')
    expect(source).not.toContain('Non-trivial means: 3+ file edits')
  })
})
