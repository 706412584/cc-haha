#!/usr/bin/env bun

import WebSocket from 'ws'

const baseUrl = process.argv[2] ?? process.env.CC_HAHA_ANDROID_BASE_URL ?? 'http://127.0.0.1:3456'
const sessionId = process.argv[3] ?? `android-spike-${Date.now()}`
const timeoutMs = Number.parseInt(process.env.CC_HAHA_ANDROID_CHECK_TIMEOUT_MS ?? '5000', 10)

if (!/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
  throw new Error('Session id must match /^[0-9a-zA-Z_-]{1,64}$/ to satisfy the server WebSocket route')
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

async function checkHealth() {
  const url = new URL('/health', baseUrl)
  const response = await withTimeout(fetch(url), 'health check')
  if (!response.ok) {
    throw new Error(`health check failed: HTTP ${response.status}`)
  }

  const body = await response.json() as { status?: string; timestamp?: string }
  if (body.status !== 'ok') {
    throw new Error(`health check returned unexpected body: ${JSON.stringify(body)}`)
  }

  return body
}

function toWebSocketUrl(base: string, session: string) {
  const url = new URL(`/ws/${encodeURIComponent(session)}`, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

async function checkWebSocket() {
  const wsUrl = toWebSocketUrl(baseUrl, sessionId)

  return withTimeout(new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)

    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'ping' }))
    })

    ws.on('message', (data) => {
      const text = data.toString()
      try {
        const message = JSON.parse(text) as { type?: string }
        if (message.type === 'connected') return
        if (message.type !== 'pong') {
          reject(new Error(`unexpected WebSocket message: ${text}`))
          ws.close()
          return
        }
        resolve(text)
        ws.close()
      } catch (error) {
        reject(error)
        ws.close()
      }
    })

    ws.once('error', reject)
  }), 'websocket ping')
}

console.log('Android local runtime server probe')
console.log('==================================')
console.log(`Base URL: ${baseUrl}`)
console.log(`Session: ${sessionId}`)

const health = await checkHealth()
console.log(`\n[OK] GET /health -> ${JSON.stringify(health)}`)

const pong = await checkWebSocket()
console.log(`[OK] WebSocket ping -> ${pong}`)

console.log('\nServer transport checks passed.')
