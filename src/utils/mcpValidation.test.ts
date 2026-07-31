import { afterEach, describe, expect, test } from 'bun:test'
import { truncateMcpContent } from './mcpValidation.js'

const originalLimit = process.env.MAX_MCP_OUTPUT_TOKENS

afterEach(() => {
  if (originalLimit === undefined) {
    delete process.env.MAX_MCP_OUTPUT_TOKENS
  } else {
    process.env.MAX_MCP_OUTPUT_TOKENS = originalLimit
  }
})

describe('truncateMcpContent memory ownership', () => {
  test('does not retain the backing store of a large string', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '1000'
    Bun.gc(true)
    const baselineExternal = process.memoryUsage().external

    let content = Buffer.alloc(32 * 1024 * 1024, 97).toString('utf8')
    const truncated = await truncateMcpContent(content)
    content = ''
    await waitForExternalMemoryRelease(baselineExternal)

    expect(typeof truncated).toBe('string')
    expect(truncated).toStartWith('a'.repeat(4_000))
  })

  test('does not split a surrogate pair at the truncation boundary', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '1000'
    const content = `${'a'.repeat(3_999)}😀tail`

    const truncated = await truncateMcpContent(content)

    expect(typeof truncated).toBe('string')
    expect(truncated).not.toContain('\ud83d')
  })

  test('detaches a truncated text block from its backing string', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '1000'
    const content = 'x'.repeat(8_000)

    const truncated = await truncateMcpContent([
      { type: 'text', text: content },
    ])

    if (!Array.isArray(truncated)) {
      throw new Error('expected content blocks')
    }
    expect(truncated[0]).toEqual({
      type: 'text',
      text: 'x'.repeat(4_000),
    })
  })

  test('detaches fully retained text blocks when later blocks exceed the limit', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '1000'
    Bun.gc(true)
    const baselineExternal = process.memoryUsage().external

    const truncated = await truncateRetainedBlockFromLargeBacking()
    await waitForExternalMemoryRelease(baselineExternal)

    expect(Array.isArray(truncated)).toBe(true)
  })

  test('detaches direct strings even when truncateMcpContent receives a short slice', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '1000'
    Bun.gc(true)
    const baselineExternal = process.memoryUsage().external

    const truncated = await truncateDirectSliceFromLargeBacking()
    await waitForExternalMemoryRelease(baselineExternal)

    expect(truncated).toStartWith('a'.repeat(3_000))
  })
})

async function truncateRetainedBlockFromLargeBacking() {
  const backing = Buffer.alloc(32 * 1024 * 1024, 97).toString('utf8')
  return truncateMcpContent([
    { type: 'text', text: backing.slice(0, 3_000) },
    { type: 'text', text: 'b'.repeat(8_000) },
  ])
}

async function truncateDirectSliceFromLargeBacking() {
  const backing = Buffer.alloc(32 * 1024 * 1024, 97).toString('utf8')
  return truncateMcpContent(backing.slice(0, 3_000))
}

async function waitForExternalMemoryRelease(
  baselineExternal: number,
): Promise<void> {
  const maximumRetainedBytes = 8 * 1024 * 1024
  const deadline = Date.now() + 2_000
  while (
    process.memoryUsage().external - baselineExternal >= maximumRetainedBytes &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10)
    Bun.gc(true)
  }
  expect(process.memoryUsage().external - baselineExternal).toBeLessThan(
    maximumRetainedBytes,
  )
}
