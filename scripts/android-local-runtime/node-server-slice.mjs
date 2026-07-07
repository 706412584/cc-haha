#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const host = readArg('--host') ?? process.env.CC_HAHA_ANDROID_NODE_HOST ?? '127.0.0.1'
const port = Number.parseInt(readArg('--port') ?? process.env.CC_HAHA_ANDROID_NODE_PORT ?? '3456', 10)
const h5DistDir = resolve(readArg('--h5-dist') ?? process.env.CLAUDE_H5_DIST_DIR ?? join(process.cwd(), 'desktop', 'dist'))
const sessions = new Map()

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!body.trim()) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function createSession(input = {}) {
  const now = new Date().toISOString()
  const workDir = typeof input.workDir === 'string' && input.workDir.trim()
    ? input.workDir
    : process.cwd()
  const session = {
    id: randomUUID(),
    title: 'Android local session',
    createdAt: now,
    modifiedAt: now,
    messageCount: 0,
    projectPath: workDir,
    projectRoot: workDir,
    workDir,
    workDirExists: existsSync(workDir),
    permissionMode: 'default',
    messages: [],
  }
  sessions.set(session.id, session)
  return session
}

function sessionListItem(session) {
  const { messages: _messages, ...item } = session
  return item
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { status: 'ok', timestamp: new Date().toISOString() })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const items = Array.from(sessions.values()).map(sessionListItem)
    json(res, 200, { sessions: items, total: items.length })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    try {
      const body = await readJsonBody(req)
      const session = createSession(body)
      json(res, 200, { sessionId: session.id, workDir: session.workDir })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  const messagesMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-zA-Z_-]{1,64})\/messages$/)
  if (req.method === 'GET' && messagesMatch) {
    const session = sessions.get(messagesMatch[1])
    if (!session) {
      json(res, 404, { error: 'Session not found' })
      return true
    }
    json(res, 200, { messages: session.messages, taskNotifications: [] })
    return true
  }

  return false
}

function containedPath(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const target = resolve(root, relative)
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(normalizedRoot)) return null
  return target
}

function resolveStaticFile(url) {
  if (!existsSync(join(h5DistDir, 'index.html'))) return null
  const direct = containedPath(h5DistDir, url.pathname)
  if (!direct) return null
  if (existsSync(direct) && statSync(direct).isFile()) return direct
  if (existsSync(join(direct, 'index.html'))) return join(direct, 'index.html')
  if (extname(direct)) return null
  return join(h5DistDir, 'index.html')
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const file = resolveStaticFile(url)
  if (!file) return false
  const stat = statSync(file)
  const type = MIME_TYPES[extname(file)] ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    'content-length': stat.size,
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file).pipe(res)
  return true
}

function textFrame(text) {
  const payload = Buffer.from(text)
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, payload])
  }
  throw new Error('payload too large')
}

function parseClientTextFrame(buffer) {
  const opcode = buffer[0] & 0x0f
  if (opcode === 0x8) return null
  if (opcode !== 0x1) throw new Error(`unsupported opcode: ${opcode}`)
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    throw new Error('large websocket frames are not supported in this slice')
  }
  if (!masked) throw new Error('client frame must be masked')
  const mask = buffer.subarray(offset, offset + 4)
  offset += 4
  const payload = buffer.subarray(offset, offset + length)
  const decoded = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) {
    decoded[index] = payload[index] ^ mask[index % 4]
  }
  return decoded.toString('utf8')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
  if (await handleApi(req, res, url)) return
  if (url.pathname.startsWith('/api/')) {
    json(res, 404, { error: 'API route not found' })
    return
  }
  if (serveStatic(req, res, url)) return
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not found')
})

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`)
  const sessionId = url.pathname.startsWith('/ws/') ? url.pathname.split('/').pop() : ''
  if (!sessionId || !/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'))

  socket.write(textFrame(JSON.stringify({ type: 'connected', sessionId })))
  socket.on('error', () => {})
  socket.on('data', (buffer) => {
    try {
      const text = parseClientTextFrame(buffer)
      if (!text) return
      const message = JSON.parse(text)
      if (message.type === 'ping') {
        socket.write(textFrame(JSON.stringify({ type: 'pong' })))
      } else {
        socket.write(textFrame(JSON.stringify({ type: 'error', message: `Unknown message type: ${message.type}` })))
      }
    } catch (error) {
      socket.write(textFrame(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })))
    }
  })
})

server.listen(port, host, () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  console.log(`[android-node-slice] listening at http://${host}:${actualPort}`)
  console.log(`[android-node-slice] h5 dist: ${existsSync(join(h5DistDir, 'index.html')) ? h5DistDir : '(not found)'}`)
})
