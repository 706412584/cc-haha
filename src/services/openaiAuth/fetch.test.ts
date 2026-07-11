import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { OPENAI_CODEX_API_ENDPOINT } from './client.js'
import { buildOpenAICodexFetch } from './fetch.js'
import { OPENAI_CODEX_REASONING_EFFORT_ENV_KEY } from './models.js'
import { clearOpenAIOAuthTokenCache } from './storage.js'

describe('buildOpenAICodexFetch', () => {
  let tmpDir: string
  let originalTokenFile: string | undefined
  let originalReasoningEffort: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-codex-fetch-'))
    originalTokenFile = process.env.OPENAI_CODEX_OAUTH_FILE
    originalReasoningEffort = process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]
    delete process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]
    process.env.OPENAI_CODEX_OAUTH_FILE = path.join(tmpDir, 'openai-oauth.json')
    clearOpenAIOAuthTokenCache()
    await fs.writeFile(
      process.env.OPENAI_CODEX_OAUTH_FILE,
      JSON.stringify({
        accessToken: 'access-for-chatgpt',
        refreshToken: 'refresh-for-chatgpt',
        expiresAt: Date.now() + 60 * 60_000,
        accountId: 'acct_fetch',
        email: 'user@example.com',
      }),
      'utf-8',
    )
  })

  afterEach(async () => {
    if (originalTokenFile === undefined) {
      delete process.env.OPENAI_CODEX_OAUTH_FILE
    } else {
      process.env.OPENAI_CODEX_OAUTH_FILE = originalTokenFile
    }
    if (originalReasoningEffort === undefined) {
      delete process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]
    } else {
      process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY] = originalReasoningEffort
    }
    clearOpenAIOAuthTokenCache()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('maps Anthropic messages to ChatGPT Codex responses endpoint with account header', async () => {
    const upstreamCalls: Array<{
      url: string
      headers: Record<string, string>
      body: Record<string, unknown>
    }> = []
    const fetchOverride: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      upstreamCalls.push({
        url: String(input),
        headers: Object.fromEntries(headers.entries()),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return Response.json({
        id: 'resp_123',
        object: 'response',
        created_at: 1_779_118_000,
        model: 'gpt-5.5',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }

    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'test')
    const response = await openAIFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    })

    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0].url).toBe(OPENAI_CODEX_API_ENDPOINT)
    expect(upstreamCalls[0].headers.authorization).toBe('Bearer access-for-chatgpt')
    expect(upstreamCalls[0].headers['chatgpt-account-id']).toBe('acct_fetch')
    expect(upstreamCalls[0].headers.originator).toBe('codex_cli_rs')
    expect(upstreamCalls[0].body.model).toBe('gpt-5.5')
    expect(upstreamCalls[0].body.reasoning).toEqual({ effort: 'medium' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      type: 'message',
      model: 'gpt-5.5',
      content: [{ type: 'text', text: 'ok' }],
    })
  })

  test('uses streamed Codex responses even for non-streaming Anthropic callers', async () => {
    const upstreamCalls: Array<{
      url: string
      body: Record<string, unknown>
    }> = []
    const fetchOverride: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamCalls.push({
        url: String(input),
        body,
      })
      return new Response([
        'event: response.completed',
        'data: {"response":{"id":"resp_456","object":"response","created_at":1779118000,"model":"gpt-5.5","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"streamed ok"}]}],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
        '',
      ].join('\n'), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'test')
    const response = await openAIFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    })

    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0].url).toBe(OPENAI_CODEX_API_ENDPOINT)
    expect(upstreamCalls[0].body.stream).toBe(true)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    await expect(response.json()).resolves.toMatchObject({
      type: 'message',
      model: 'gpt-5.5',
      content: [{ type: 'text', text: 'streamed ok' }],
    })
  })

  test('applies model defaults and preserves native xhigh/max efforts on the final request', async () => {
    const upstreamBodies: Array<Record<string, unknown>> = []
    const fetchOverride: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamBodies.push(body)
      return Response.json({
        id: `resp_${upstreamBodies.length}`,
        object: 'response',
        created_at: 1_779_118_000,
        model: body.model,
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }
    const openAIFetch = buildOpenAICodexFetch(fetchOverride, 'test')

    const send = async (model: string, effort?: string) => {
      if (effort) process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY] = effort
      else delete process.env[OPENAI_CODEX_REASONING_EFFORT_ENV_KEY]
      await openAIFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Say ok' }],
        }),
      })
    }

    await send('gpt-5.6-sol')
    await send('gpt-5.6-terra')
    await send('gpt-5.6-sol', 'xhigh')
    await send('gpt-5.6-luna', 'max')
    await send('gpt-5.5', 'max')

    expect(upstreamBodies.map((body) => body.reasoning)).toEqual([
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'medium' },
    ])
  })
})
