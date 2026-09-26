import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleOrchestrationPromptsApi } from '../api/orchestration-prompts.js'
import { MAX_PROMPT_CHARS } from '../services/orchestrationPromptPreferencesService.js'
import { ORCHESTRATION_SYSTEM_PROMPT } from '../orchestrationPrompt.js'
import { getSoloPipelineSystemPrompt } from '../../coordinator/soloPipelinePrompt.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestration-prompts-api-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
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
  return handleOrchestrationPromptsApi(
    new Request(url.toString(), init),
    url,
    url.pathname.split('/').filter(Boolean),
  )
}

type PromptEntry = { default: string; custom: string | null; effective: string; isCustom: boolean }
type GetResponse = { prompts: Record<string, PromptEntry>; maxChars: number }

describe('orchestration prompts API', () => {
  test('GET reports default/custom/effective for all three modes', async () => {
    const response = await api('GET', '/api/orchestration-prompts')
    expect(response.status).toBe(200)

    const body = await response.json() as GetResponse
    expect(body.maxChars).toBe(MAX_PROMPT_CHARS)
    expect(Object.keys(body.prompts).sort()).toEqual(['coordinator', 're', 'solo'])
    expect(body.prompts.coordinator!.effective).toBe(ORCHESTRATION_SYSTEM_PROMPT)
    expect(body.prompts.solo!.effective).toBe(getSoloPipelineSystemPrompt())
    for (const entry of Object.values(body.prompts)) {
      expect(entry.isCustom).toBe(false)
      expect(entry.custom).toBeNull()
    }
  })

  test('PUT stores an override and GET reflects it', async () => {
    const put = await api('PUT', '/api/orchestration-prompts/solo', { text: 'MY SOLO' })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ ok: true, mode: 'solo', isCustom: true })

    const body = await (await api('GET', '/api/orchestration-prompts')).json() as GetResponse
    expect(body.prompts.solo!.effective).toBe('MY SOLO')
    expect(body.prompts.solo!.isCustom).toBe(true)
    expect(body.prompts.coordinator!.isCustom).toBe(false)
  })

  test('DELETE restores the built-in prompt', async () => {
    await api('PUT', '/api/orchestration-prompts/re', { text: 'MY RE' })

    const del = await api('DELETE', '/api/orchestration-prompts/re')
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true, mode: 're', isCustom: false })

    const body = await (await api('GET', '/api/orchestration-prompts')).json() as GetResponse
    expect(body.prompts.re!.isCustom).toBe(false)
  })

  test('PUT with whitespace-only text reports the reset that actually happened', async () => {
    await api('PUT', '/api/orchestration-prompts/solo', { text: 'MY SOLO' })

    const put = await api('PUT', '/api/orchestration-prompts/solo', { text: '   ' })
    expect(await put.json()).toEqual({ ok: true, mode: 'solo', isCustom: false })
  })

  test('rejects an unknown mode', async () => {
    expect((await api('PUT', '/api/orchestration-prompts/bogus', { text: 'x' })).status).toBe(400)
    expect((await api('DELETE', '/api/orchestration-prompts/bogus')).status).toBe(400)
  })

  test('rejects an oversized prompt', async () => {
    const response = await api('PUT', '/api/orchestration-prompts/solo', {
      text: 'x'.repeat(MAX_PROMPT_CHARS + 1),
    })
    expect(response.status).toBe(400)
  })

  test('rejects a missing or non-string text field', async () => {
    expect((await api('PUT', '/api/orchestration-prompts/solo', {})).status).toBe(400)
    expect((await api('PUT', '/api/orchestration-prompts/solo', { text: 42 })).status).toBe(400)
  })

  test('rejects methods other than GET/PUT/DELETE', async () => {
    expect((await api('POST', '/api/orchestration-prompts')).status).toBe(405)
    expect((await api('POST', '/api/orchestration-prompts/solo', { text: 'x' })).status).toBe(405)
  })
})
