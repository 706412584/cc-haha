#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { Socket } from 'node:net'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3456'
const sessionId = process.argv[3] ?? `android-node-${Date.now()}`

if (!/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
  throw new Error('Session id must match /^[0-9a-zA-Z_-]{1,64}$/')
}

function getHealth() {
  return new Promise((resolve, reject) => {
    const url = new URL('/health', baseUrl)
    const req = request(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`health failed: HTTP ${res.statusCode} ${body}`))
          return
        }
        resolve(body)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function clientTextFrame(text) {
  const payload = Buffer.from(text)
  const mask = randomBytes(4)
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
  const masked = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4]
  }
  return Buffer.concat([header, mask, masked])
}

function parseServerFrame(buffer) {
  const opcode = buffer[0] & 0x0f
  if (opcode !== 0x1) return null
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    throw new Error('large websocket frames are not supported')
  }
  return buffer.subarray(offset, offset + length).toString('utf8')
}

function checkWebSocket() {
  return new Promise((resolve, reject) => {
    const url = new URL(`/ws/${sessionId}`, baseUrl)
    const socket = new Socket()
    const key = randomBytes(16).toString('base64')
    const expectedAccept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    let handshake = ''
    let upgraded = false

    socket.setTimeout(5000, () => reject(new Error('websocket timed out')))
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write([
        `GET ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'))
    })
    socket.on('data', (chunk) => {
      if (!upgraded) {
        handshake += chunk.toString('binary')
        const end = handshake.indexOf('\r\n\r\n')
        if (end === -1) return
        if (!handshake.startsWith('HTTP/1.1 101')) {
          reject(new Error(`upgrade failed: ${handshake.slice(0, end)}`))
          socket.destroy()
          return
        }
        if (!handshake.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
          reject(new Error('unexpected Sec-WebSocket-Accept'))
          socket.destroy()
          return
        }
        upgraded = true
        socket.write(clientTextFrame(JSON.stringify({ type: 'ping' })))
        return
      }

      const text = parseServerFrame(chunk)
      if (!text) return
      const message = JSON.parse(text)
      if (message.type === 'connected') return
      if (message.type !== 'pong') {
        reject(new Error(`unexpected websocket message: ${text}`))
        socket.destroy()
        return
      }
      resolve(text)
      socket.end()
    })
    socket.connect(url.port ? Number(url.port) : 80, url.hostname)
  })
}

console.log('Android Node transport client probe')
console.log('===================================')
console.log(`Base URL: ${baseUrl}`)
console.log(`Session: ${sessionId}`)

const health = await getHealth()
console.log(`\n[OK] GET /health -> ${health}`)

const pong = await checkWebSocket()
console.log(`[OK] WebSocket ping -> ${pong}`)
