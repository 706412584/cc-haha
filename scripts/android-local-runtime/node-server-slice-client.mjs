#!/usr/bin/env node

import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { Socket } from 'node:net'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3456'

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(url, {
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : undefined,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${path} failed: HTTP ${res.statusCode} ${text}`))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function httpText(method, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const req = request(url, { method }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, text }))
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

function checkWebSocket(sessionId) {
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

console.log('Android Node server slice client probe')
console.log('======================================')
console.log(`Base URL: ${baseUrl}`)

const health = await httpJson('GET', '/health')
if (health.status !== 'ok') throw new Error(`unexpected health: ${JSON.stringify(health)}`)
console.log(`\n[OK] GET /health -> ${JSON.stringify(health)}`)

const before = await httpJson('GET', '/api/sessions')
if (!Array.isArray(before.sessions) || typeof before.total !== 'number') {
  throw new Error(`unexpected sessions list: ${JSON.stringify(before)}`)
}
console.log(`[OK] GET /api/sessions -> ${before.total}`)

const created = await httpJson('POST', '/api/sessions', { workDir: process.cwd() })
if (!created.sessionId) throw new Error(`missing sessionId: ${JSON.stringify(created)}`)
console.log(`[OK] POST /api/sessions -> ${created.sessionId}`)

const after = await httpJson('GET', '/api/sessions')
if (!after.sessions.some((session) => session.id === created.sessionId)) {
  throw new Error(`created session missing from list: ${JSON.stringify(after)}`)
}
console.log(`[OK] created session appears in list`)

const messages = await httpJson('GET', `/api/sessions/${created.sessionId}/messages`)
if (!Array.isArray(messages.messages)) throw new Error(`unexpected messages: ${JSON.stringify(messages)}`)
console.log(`[OK] GET /api/sessions/:id/messages -> ${messages.messages.length}`)

const pong = await checkWebSocket(created.sessionId)
console.log(`[OK] WebSocket ping -> ${pong}`)

const root = await httpText('GET', '/')
console.log(`[INFO] GET / -> HTTP ${root.statusCode}`)
