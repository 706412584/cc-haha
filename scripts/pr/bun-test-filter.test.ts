import { describe, expect, test } from 'bun:test'
import { rootBunTestFilter } from './bun-test-filter'

describe('rootBunTestFilter', () => {
  test('roots repository-relative files and directories', () => {
    expect(rootBunTestFilter('src/server/example.test.ts')).toBe(
      './src/server/example.test.ts',
    )
    expect(rootBunTestFilter('electron')).toBe('./electron')
  })

  test('preserves already rooted and absolute filters', () => {
    expect(rootBunTestFilter('./src/example.test.ts')).toBe(
      './src/example.test.ts',
    )
    expect(rootBunTestFilter('../shared/example.test.ts')).toBe(
      '../shared/example.test.ts',
    )
    expect(rootBunTestFilter('/tmp/example.test.ts')).toBe(
      '/tmp/example.test.ts',
    )
    expect(rootBunTestFilter('C:\\repo\\example.test.ts')).toBe(
      'C:\\repo\\example.test.ts',
    )
  })
})
