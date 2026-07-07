#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const host = readArg('--host') ?? process.env.CC_HAHA_ANDROID_NODE_HOST ?? '127.0.0.1'
const port = Number.parseInt(readArg('--port') ?? process.env.CC_HAHA_ANDROID_NODE_PORT ?? '3456', 10)

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
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
    throw new Error('large websocket frames are not supported in this smoke server')
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

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }))
    return
  }

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

  socket.on('error', () => {
    // Probe clients may close immediately after receiving pong.
  })

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
  console.log(`[android-node-smoke] listening at http://${host}:${port}`)
})
