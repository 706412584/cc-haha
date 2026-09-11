import { describe, expect, test } from 'bun:test'
import { compileReplCell } from './replCompiler'

describe('computer use REPL compiler', () => {
  test('collects persistent declarations without capturing nested lexical scopes', () => {
    const compiled = compileReplCell(`
      const { x, nested: { y = 2 }, ...rest } = source
      let [first, ...tail] = values
      async function act() { const local = 1; return local }
      class Target {}
      for (var index of [1, 2]) { var visited = index; let scoped = 3 }
      { let hidden = 4; function nested() {} }
    `, [])
    expect(compiled.bindings).toEqual([
      { name: 'x', kind: 'const' },
      { name: 'y', kind: 'const' },
      { name: 'rest', kind: 'const' },
      { name: 'first', kind: 'let' },
      { name: 'tail', kind: 'let' },
      { name: 'act', kind: 'function' },
      { name: 'Target', kind: 'class' },
      { name: 'index', kind: 'var' },
      { name: 'visited', kind: 'var' },
    ])
  })

  test('accepts top level await and redeclarations of prior bindings', () => {
    const compiled = compileReplCell('const app = await select(); let next = app', [
      { name: 'app', kind: 'const' },
      { name: 'previous', kind: 'let' },
    ])
    expect(compiled.bindings).toEqual([
      { name: 'previous', kind: 'let' },
      { name: 'app', kind: 'const' },
      { name: 'next', kind: 'let' },
    ])
  })

  test.each([
    'import fs from "node:fs"',
    'await import("node:fs")',
    'async function later() { return import("node:fs") }',
    'export const x = 1',
    'import.meta.url',
  ])('rejects module access: %s', code => {
    expect(() => compileReplCell(code, [])).toThrow('not available')
  })

  test('rejects syntax errors before any execution', () => {
    expect(() => compileReplCell('await action(); const broken =', [])).toThrow()
  })

  test('warns for writes to previous const bindings without confusing local shadows or object properties', () => {
    const prior = [{ name: 'count', kind: 'const' as const }]
    expect(compileReplCell('count++', prior).warnings).toHaveLength(1)
    expect(compileReplCell('({value: count} = source)', prior).warnings).toHaveLength(1)
    expect(compileReplCell('function increment() { count++ }', prior).warnings).toHaveLength(1)
    for (const code of [
      'count.value++',
      'function local(count) { count++ }',
      'function local() { count++; var count = 0 }',
      '{ let count = 0; count++ }',
      'for (let count = 0; count < 2; count++) {}',
      'try {} catch (count) { count++ }',
    ]) {
      expect(compileReplCell(code, prior).warnings).toEqual([])
    }
  })
})
