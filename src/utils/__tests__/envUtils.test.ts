import { describe, expect, test } from 'bun:test'
import { parseMegabyteEnvToBytes } from '../envUtils.js'

describe('parseMegabyteEnvToBytes', () => {
  test('returns undefined when unset so callers fall back to their default', () => {
    expect(parseMegabyteEnvToBytes(undefined)).toBeUndefined()
  })

  test('converts a positive integer MB value to bytes', () => {
    expect(parseMegabyteEnvToBytes('256')).toBe(256 * 1024 * 1024)
  })

  test('trims surrounding whitespace before parsing', () => {
    expect(parseMegabyteEnvToBytes('  512  ')).toBe(512 * 1024 * 1024)
  })

  test('truncates fractional MB values toward zero', () => {
    expect(parseMegabyteEnvToBytes('1.9')).toBe(1 * 1024 * 1024)
  })

  test('rejects non-positive and non-numeric values as undefined', () => {
    expect(parseMegabyteEnvToBytes('0')).toBeUndefined()
    expect(parseMegabyteEnvToBytes('-5')).toBeUndefined()
    expect(parseMegabyteEnvToBytes('abc')).toBeUndefined()
    expect(parseMegabyteEnvToBytes('')).toBeUndefined()
  })
})
