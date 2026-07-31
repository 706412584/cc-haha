import { afterEach, describe, expect, it } from 'bun:test'
import {
  parseSSEFrames,
  SSE_MAX_FRAME_BYTES,
  SSETransport,
} from './SSETransport.js'

const originalFetch = globalThis.fetch
const globals = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string }
}
const originalMacro = globals.MACRO

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
})

describe('parseSSEFrames size limits', () => {
  it('still parses normal frames and preserves an incomplete tail', () => {
    const parsed = parseSSEFrames(
      'event: client_event\ndata: {"ok":true}\n\nid: partial',
    )

    expect(parsed.frames).toEqual([
      { event: 'client_event', data: '{"ok":true}' },
    ])
    expect(parsed.remaining).toBe('id: partial')
  })

  it('rejects an oversized incomplete frame', () => {
    expect(() => parseSSEFrames(`data: ${'x'.repeat(SSE_MAX_FRAME_BYTES + 1)}`))
      .toThrow('SSE frame exceeds')
  })

  it('rejects an oversized complete frame before parsing its fields', () => {
    expect(() => parseSSEFrames(`data: ${'x'.repeat(SSE_MAX_FRAME_BYTES + 1)}\n\n`))
      .toThrow('SSE frame exceeds')
  })
})

describe('SSETransport oversized frames', () => {
  it('closes permanently instead of reconnecting after a frame exceeds the limit', async () => {
    globalThis.fetch = (async () => new Response(
      `data: ${'x'.repeat(SSE_MAX_FRAME_BYTES + 1)}`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch
    globals.MACRO = { VERSION: 'test' }

    const transport = new SSETransport(
      new URL('https://example.test/v2/session/events/stream'),
      {},
      'test-session',
      undefined,
      undefined,
      () => ({ Authorization: 'Bearer test' }),
    )
    let closeCalls = 0
    transport.setOnClose(() => {
      closeCalls += 1
    })

    try {
      await transport.connect()
      expect(transport.isClosedStatus()).toBe(true)
      expect(closeCalls).toBe(1)
    } finally {
      transport.close()
    }
  })
})
