/** Loopback HTTP fixture shared by downloader and runtime tests. Test-only. */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { DownloadAsset } from './downloader.js'

export interface RecordedRequest {
  method: string
  range: string | undefined
  path: string
}

export interface FixtureBehavior {
  /** Ignore Range headers and always answer 200 with the full body. */
  ignoreRange?: boolean
  /** Answer 416 to any request that carries a Range header. */
  rangeNotSatisfiable?: boolean
  /** Force this status for GET requests (HEAD stays 200 unless `headStatus`). */
  status?: number
  headStatus?: number
  headDelayMs?: number
  /** Destroy the socket after sending this many body bytes, for the first N GETs. */
  breakAfter?: number
  breakRequests?: number
  /** Pause between 16 KiB chunks. */
  chunkDelayMs?: number
  /** Stall forever after this many body bytes (never ends). */
  stallAfter?: number
  /** Serve different bytes of the same length. */
  body?: Buffer
}

export interface Fixture {
  origin: string
  requests: RecordedRequest[]
  gets(): RecordedRequest[]
  behavior: FixtureBehavior
  close(): Promise<void>
}

/**
 * Keeps loopback fetches off any proxy configured in the ambient environment
 * (a developer TUN/HTTP proxy would otherwise mangle fixture traffic).
 * Returns a restore function.
 */
export function bypassProxyForLoopback(): () => void {
  const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
  process.env.NO_PROXY = '127.0.0.1,localhost,::1'
  process.env.no_proxy = '127.0.0.1,localhost,::1'
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export function makeContent(size: number, seed = 7): Buffer {
  const buffer = Buffer.alloc(size)
  let state = seed
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    buffer[i] = state >> 16
  }
  return buffer
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function assetFor(content: Buffer, urls: string[], name = 'fixture.bin'): DownloadAsset {
  return { name, bytes: content.length, hash: { algorithm: 'sha256', encoding: 'hex', value: sha256Hex(content) }, urls }
}

export async function startFixture(content: Buffer, behavior: FixtureBehavior = {}): Promise<Fixture> {
  const requests: RecordedRequest[] = []
  let getCount = 0
  const sockets = new Set<import('node:net').Socket>()

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const method = request.method ?? 'GET'
    const range = request.headers.range
    requests.push({ method, range, path: request.url ?? '/' })
    const payload = fixture.behavior.body ?? content

    if (method === 'HEAD') {
      const delay = fixture.behavior.headDelayMs ?? 0
      setTimeout(() => {
        response.writeHead(fixture.behavior.headStatus ?? 200, { 'content-length': String(payload.length) }).end()
      }, delay)
      return
    }

    const attempt = ++getCount
    if (fixture.behavior.status && fixture.behavior.status !== 200) {
      response.writeHead(fixture.behavior.status).end('nope')
      return
    }
    if (range && fixture.behavior.rangeNotSatisfiable) {
      response.writeHead(416, { 'content-range': `bytes */${payload.length}` }).end()
      return
    }

    let start = 0
    let status = 200
    const match = /^bytes=(\d+)-$/.exec(range ?? '')
    if (match && !fixture.behavior.ignoreRange) {
      start = Number(match[1])
      status = 206
    }
    const body = payload.subarray(start)
    const headers: Record<string, string> = { 'content-length': String(body.length) }
    if (status === 206) headers['content-range'] = `bytes ${start}-${payload.length - 1}/${payload.length}`
    response.writeHead(status, headers)

    const breakAfter = fixture.behavior.breakAfter
    const breaking = breakAfter !== undefined && attempt <= (fixture.behavior.breakRequests ?? Infinity)
    const stallAfter = fixture.behavior.stallAfter
    const limit = breaking ? breakAfter : stallAfter !== undefined ? stallAfter : body.length
    const chunkSize = 16 * 1024
    let sent = 0
    const pump = (): void => {
      if (response.destroyed) return
      if (sent >= limit) {
        if (breaking) {
          setTimeout(() => response.destroy(), 20)
        } else if (stallAfter === undefined) {
          response.end()
        }
        return
      }
      const chunk = body.subarray(sent, Math.min(sent + chunkSize, limit))
      sent += chunk.length
      response.write(chunk, () => {
        const delay = fixture.behavior.chunkDelayMs ?? 0
        if (delay > 0) setTimeout(pump, delay)
        else setImmediate(pump)
      })
    }
    pump()
  }

  const server = createServer(handle)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const fixture: Fixture = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    gets: () => requests.filter(request => request.method === 'GET'),
    behavior,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
  return fixture
}
