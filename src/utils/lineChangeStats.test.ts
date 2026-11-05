import { describe, expect, it } from 'bun:test'
import { countLineChangeStats } from './lineChangeStats.js'

describe('countLineChangeStats', () => {
  it('counts a small edit exactly', () => {
    expect(countLineChangeStats('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ insertions: 2, deletions: 1 })
    expect(countLineChangeStats('', 'x\ny\n')).toEqual({ insertions: 2, deletions: 0 })
  })

  it('bounds a whole-file rewrite instead of running an unbounded diff', () => {
    const lines = Array.from({ length: 7_000 }, (_, i) => `line ${i} ${'x'.repeat(30)}`)
    const before = lines.join('\n') + '\n'
    const after = lines.join('\r\n') + '\r\n'
    const startedAt = performance.now()
    const stats = countLineChangeStats(before, after)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(stats).toEqual({ insertions: 7_000, deletions: 7_000 })
  })
})
