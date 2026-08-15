import { describe, expect, test } from 'bun:test'
import {
  parseWorkflowScript,
  renameWorkflowScript,
  usesBannedNondeterminism,
} from './meta.js'

describe('parseWorkflowScript', () => {
  test('extracts meta and leaves the body executable', () => {
    const parsed = parseWorkflowScript(
      [
        "export const meta = { name: 'audit', description: 'Audit routes' }",
        "const found = await agent('list files')",
        'return found',
      ].join('\n'),
    )
    expect(parsed).not.toHaveProperty('error')
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.meta.name).toBe('audit')
    expect(parsed.meta.description).toBe('Audit routes')
    expect(parsed.scriptBody).toBe(
      "const found = await agent('list files')\nreturn found",
    )
  })

  test('keeps phases with their detail and model', () => {
    const parsed = parseWorkflowScript(
      [
        'export const meta = {',
        "  name: 'review',",
        "  description: 'Review the diff',",
        "  whenToUse: 'before merging',",
        '  phases: [',
        "    { title: 'Find', detail: 'one agent per file' },",
        "    { title: 'Verify', model: 'sonnet' },",
        '  ],',
        '}',
        'return []',
      ].join('\n'),
    )
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.meta.whenToUse).toBe('before merging')
    expect(parsed.meta.phases).toEqual([
      { title: 'Find', detail: 'one agent per file' },
      { title: 'Verify', model: 'sonnet' },
    ])
  })

  test('rejects a script whose first statement is not the meta export', () => {
    const parsed = parseWorkflowScript(
      ["const x = 1", "export const meta = { name: 'a', description: 'b' }"].join(
        '\n',
      ),
    )
    expect(parsed).toEqual({
      error:
        '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    })
  })

  test.each([
    ['a call', "export const meta = { name: 'a', description: makeIt() }\n"],
    ['an identifier', "export const meta = { name: 'a', description: other }\n"],
    [
      'interpolation',
      'export const meta = { name: `a${1}`, description: "b" }\n',
    ],
    [
      'a spread',
      "export const meta = { ...base, name: 'a', description: 'b' }\n",
    ],
  ])('rejects meta containing %s', (_label, script) => {
    const parsed = parseWorkflowScript(script)
    expect('error' in parsed && parsed.error).toContain('pure literal')
  })

  test('rejects a name that would not be a safe command', () => {
    const parsed = parseWorkflowScript(
      "export const meta = { name: '../escape', description: 'b' }\n",
    )
    expect('error' in parsed && parsed.error).toContain('meta.name')
  })

  test('renames only the parsed meta.name while preserving the executable script', () => {
    const script = [
      'export const meta = {',
      "  name: 'generated-audit',",
      "  description: 'Audit routes named generated-audit',",
      "  phases: [{ title: 'Scan' }],",
      '}',
      "return await agent('keep generated-audit in the prompt')",
    ].join('\n')

    const renamed = renameWorkflowScript(script, 'release-audit')

    expect(renamed).not.toHaveProperty('error')
    if ('error' in renamed) throw new Error(renamed.error)
    expect(renamed.script).toContain("name: 'release-audit'")
    expect(renamed.script).toContain("description: 'Audit routes named generated-audit'")
    expect(renamed.script).toContain("agent('keep generated-audit in the prompt')")
    expect(parseWorkflowScript(renamed.script)).toMatchObject({
      meta: { name: 'release-audit', description: 'Audit routes named generated-audit' },
    })
  })

  test('rejects a requested command name before rewriting the script', () => {
    const renamed = renameWorkflowScript(
      "export const meta = { name: 'audit', description: 'Audit routes' }\nreturn []",
      '../escape',
    )

    expect('error' in renamed && renamed.error).toContain('meta.name')
  })

  test('reports TypeScript syntax with the plain-JavaScript hint', () => {
    const parsed = parseWorkflowScript(
      [
        "export const meta = { name: 'a', description: 'b' }",
        'const files: string[] = []',
      ].join('\n'),
    )
    expect('error' in parsed && parsed.error).toContain('plain JavaScript')
  })

  test('rejects a script over the byte limit', () => {
    const script = `export const meta = { name: 'a', description: 'b' }\n// ${'x'.repeat(
      600_000,
    )}`
    expect('error' in parseWorkflowScript(script)).toBe(true)
  })
})

describe('usesBannedNondeterminism', () => {
  test.each([
    ['Date.now()', 'const t = Date.now()'],
    ['new Date()', 'const t = new Date()'],
    ['Math.random()', 'const r = Math.random()'],
  ])('flags %s', (_label, body) => {
    expect(usesBannedNondeterminism(body)).toBe(true)
  })

  test('allows a Date built from an explicit timestamp', () => {
    expect(usesBannedNondeterminism('const t = new Date(args.stamp)')).toBe(
      false,
    )
  })
})
