import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildDesktopApprovalHeaders,
  getDesktopApprovalToken,
  installDesktopApprovalToken,
  resetDesktopApprovalTokenForTests,
} from './desktopApprovalAuth.js'

describe('desktop Computer Use approval capability', () => {
  afterEach(() => resetDesktopApprovalTokenForTests())

  test('starts unavailable and accepts one 256-bit capability', () => {
    expect(getDesktopApprovalToken()).toBeNull()
    const token = '1'.repeat(64)
    installDesktopApprovalToken(token)
    expect(getDesktopApprovalToken()).toBe(token)
  })

  test('allows an idempotent replay but rejects replacement or weak material', () => {
    const token = '2'.repeat(64)
    installDesktopApprovalToken(token)
    expect(() => installDesktopApprovalToken(token)).not.toThrow()
    expect(() => installDesktopApprovalToken('3'.repeat(64))).toThrow(/already installed/i)

    resetDesktopApprovalTokenForTests()
    expect(() => installDesktopApprovalToken('short')).toThrow(/256-bit/i)
  })

  test('builds an in-memory bearer header and fails closed before bootstrap', () => {
    expect(() => buildDesktopApprovalHeaders()).toThrow(/not initialized/i)
    installDesktopApprovalToken('8'.repeat(64))
    expect(buildDesktopApprovalHeaders()).toEqual({
      Authorization: `Bearer ${'8'.repeat(64)}`,
    })
  })
})
