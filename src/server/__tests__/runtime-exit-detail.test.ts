import { describe, expect, test } from 'bun:test'
import { MAX_RUNTIME_EXIT_DETAIL_BYTES } from '../services/conversationService.js'

/**
 * Pure truncation mirror of ConversationService.truncateUserVisibleErrorDetail.
 * Kept here so we can lock the chat-facing ceiling without spinning a CLI.
 */
function truncateUserVisibleErrorDetail(value: string, maxBytes = MAX_RUNTIME_EXIT_DETAIL_BYTES): string {
  if (!value) return value
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value
  const prefixBytes = Buffer.from(value.slice(0, maxBytes), 'utf-8')
  const truncated = prefixBytes
    .subarray(0, maxBytes)
    .toString('utf-8')
    .replace(/\uFFFD$/, '')
  return `${truncated}\n…[truncated]`
}

describe('runtime exit detail truncation', () => {
  test('exports a 4 KiB user-visible ceiling', () => {
    expect(MAX_RUNTIME_EXIT_DETAIL_BYTES).toBe(4 * 1024)
  })

  test('keeps short details intact', () => {
    expect(truncateUserVisibleErrorDetail('Illegal instruction')).toBe(
      'Illegal instruction',
    )
  })

  test('truncates multi-MB Bun panic dumps', () => {
    const dump = 'x'.repeat(2 * 1024 * 1024)
    const out = truncateUserVisibleErrorDetail(
      `CLI process exited unexpectedly (code 3): ${dump}`,
    )
    expect(out.endsWith('…[truncated]')).toBe(true)
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThan(
      MAX_RUNTIME_EXIT_DETAIL_BYTES + 64,
    )
    expect(out).toContain('CLI process exited unexpectedly')
  })
})
