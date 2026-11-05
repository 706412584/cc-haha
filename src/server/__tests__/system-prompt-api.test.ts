import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSystemPromptApi } from '../api/system-prompt.js'
import { MAX_SYSTEM_PROMPT_CHARS } from '../services/systemPromptPreferencesService.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-prompt-api-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  // The real CLI process gets `MACRO` from preload.ts. In tests the prompt
  // module needs it to build the built-in snapshot, so inject the same shape.
  ;(globalThis as typeof globalThis & { MACRO?: unknown }).MACRO ??= {
    VERSION: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: 'test',
    BUILD_TIME: 'test',
    FEEDBACK_CHANNEL: 'local',
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: '',
  }
})

afterEach(async () => {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function api(method: string, pathname: string, body?: Record<string, unknown>) {
  const url = new URL(pathname, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return handleSystemPromptApi(
    new Request(url.toString(), init),
    url,
    url.pathname.split('/').filter(Boolean),
  )
}

type GetResponse = { custom: string | null; isCustom: boolean; default: string; maxChars: number }

describe('system prompt API', () => {
  test('GET reports no override and a built-in snapshot with no file', async () => {
    const response = await api('GET', '/api/system-prompt')
    expect(response.status).toBe(200)

    const body = await response.json() as GetResponse
    expect(body.custom).toBeNull()
    expect(body.isCustom).toBe(false)
    expect(body.maxChars).toBe(MAX_SYSTEM_PROMPT_CHARS)
    // The built-in snapshot is the seed for the "load built-in default" button,
    // so it must carry the standard intro identity line.
    expect(body.default).toContain('You are an interactive agent that helps users')
  })

  test('PUT stores an override and GET reflects it', async () => {
    const put = await api('PUT', '/api/system-prompt', { text: 'You are a custom assistant.' })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ ok: true, isCustom: true })

    const body = await (await api('GET', '/api/system-prompt')).json() as GetResponse
    expect(body.custom).toBe('You are a custom assistant.')
    expect(body.isCustom).toBe(true)
  })

  test('DELETE restores the built-in prompt', async () => {
    await api('PUT', '/api/system-prompt', { text: 'CUSTOM' })

    const del = await api('DELETE', '/api/system-prompt')
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true, isCustom: false })

    const body = await (await api('GET', '/api/system-prompt')).json() as GetResponse
    expect(body.isCustom).toBe(false)
    expect(body.custom).toBeNull()
  })

  test('PUT with whitespace-only text reports the reset that actually happened', async () => {
    await api('PUT', '/api/system-prompt', { text: 'CUSTOM' })

    const put = await api('PUT', '/api/system-prompt', { text: '   ' })
    expect(await put.json()).toEqual({ ok: true, isCustom: false })
  })

  test('rejects an oversized prompt', async () => {
    const response = await api('PUT', '/api/system-prompt', { text: 'x'.repeat(MAX_SYSTEM_PROMPT_CHARS + 1) })
    expect(response.status).toBe(400)
  })

  test('rejects a missing or non-string text field', async () => {
    expect((await api('PUT', '/api/system-prompt', {})).status).toBe(400)
    expect((await api('PUT', '/api/system-prompt', { text: 42 })).status).toBe(400)
  })

  test('rejects methods other than GET/PUT/DELETE', async () => {
    expect((await api('POST', '/api/system-prompt')).status).toBe(405)
  })
})
