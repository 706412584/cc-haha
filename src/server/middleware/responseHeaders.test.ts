import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setResponseHeaders } from './responseHeaders'
import { withCors, type CorsResolution } from './cors'

const CORS: CorsResolution = {
  allowed: true,
  rejected: false,
  headers: { 'Access-Control-Allow-Origin': 'http://localhost:1420', Vary: 'Origin' },
}

describe('setResponseHeaders', () => {
  it('sets the headers on the response it was given, and gives that response back', () => {
    const response = new Response('body', { headers: { 'Content-Type': 'text/plain' } })

    const result = setResponseHeaders(response, { 'X-Request-Id': 'abc' })

    expect(result).toBe(response)
    expect(result.headers.get('x-request-id')).toBe('abc')
    expect(result.headers.get('content-type')).toBe('text/plain')
  })

  it('replaces a header the response already had, rather than adding a second value', () => {
    const response = new Response('body', { headers: { 'Cache-Control': 'private, no-cache' } })

    setResponseHeaders(response, { 'Cache-Control': 'no-store' })

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('builds a copy when the response will not take the headers, and keeps what it had', async () => {
    const response = new Response('body', { status: 201, statusText: 'Created', headers: { 'Content-Type': 'text/plain' } })
    const frozen = new Headers(response.headers)
    Object.defineProperty(frozen, 'set', { value: () => { throw new TypeError('immutable') } })
    Object.defineProperty(response, 'headers', { value: frozen })

    const result = setResponseHeaders(response, { 'X-Request-Id': 'abc' })

    expect(result).not.toBe(response)
    expect(result.status).toBe(201)
    expect(result.statusText).toBe('Created')
    expect(result.headers.get('x-request-id')).toBe('abc')
    expect(result.headers.get('content-type')).toBe('text/plain')
    expect(await result.text()).toBe('body')
  })
})

describe('a file served through the response decorators', () => {
  let directory: string
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'response-headers-'))
  })

  afterEach(async () => {
    server?.stop(true)
    server = null
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('keeps its Content-Length and streams the same bytes, with the headers added', async () => {
    // A rebuilt response is a JavaScript stream Bun has no length for: it goes out
    // chunked, and the file is read ahead into memory instead of handed to the socket.
    const bytes = Buffer.alloc(300 * 1024, 0x41)
    const file = path.join(directory, 'thesis.pdf')
    await fs.writeFile(file, bytes)
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => withCors(
        setResponseHeaders(new Response(Bun.file(file), { headers: { 'Content-Type': 'application/pdf' } }), { 'Server-Timing': 'app;dur=1' }),
        CORS,
      ),
    })

    const response = await fetch(`http://127.0.0.1:${server.port}/`)

    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:1420')
    expect(response.headers.get('server-timing')).toBe('app;dur=1')
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
  })
})
