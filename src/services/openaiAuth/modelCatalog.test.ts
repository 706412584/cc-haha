import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { OPENAI_CODEX_CLIENT_VERSION } from './client.js'
import {
  clearOpenAICodexModelCatalogCache,
  fetchOpenAICodexModelCatalog,
  getOpenAICodexModelCatalog,
} from './modelCatalog.js'
import { clearOpenAIOAuthTokenCache } from './storage.js'

describe('OpenAI Codex model catalog', () => {
  let tmpDir: string
  let originalTokenFile: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openai-model-catalog-'))
    originalTokenFile = process.env.OPENAI_CODEX_OAUTH_FILE
    process.env.OPENAI_CODEX_OAUTH_FILE = path.join(tmpDir, 'openai-oauth.json')
    await fs.writeFile(
      process.env.OPENAI_CODEX_OAUTH_FILE,
      JSON.stringify({
        accessToken: 'catalog-access-token',
        refreshToken: 'catalog-refresh-token',
        expiresAt: Date.now() + 60 * 60_000,
        accountId: 'acct_catalog',
      }),
      'utf8',
    )
    clearOpenAIOAuthTokenCache()
    clearOpenAICodexModelCatalogCache()
  })

  afterEach(async () => {
    if (originalTokenFile === undefined) delete process.env.OPENAI_CODEX_OAUTH_FILE
    else process.env.OPENAI_CODEX_OAUTH_FILE = originalTokenFile
    clearOpenAIOAuthTokenCache()
    clearOpenAICodexModelCatalogCache()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('loads the account model list with auth and removes unsupported product-only efforts', async () => {
    let requestUrl = ''
    let requestHeaders = new Headers()
    const models = await fetchOpenAICodexModelCatalog(async (input, init) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      return Response.json({
        models: [
          {
            slug: 'gpt-next-account-only',
            display_name: 'GPT Next',
            description: 'Account-scoped model.',
            default_reasoning_level: 'xhigh',
            supported_reasoning_levels: [
              { effort: 'low' },
              { effort: 'xhigh' },
              { effort: 'ultra' },
            ],
            visibility: 'list',
            supported_in_api: false,
            context_window: 400_000,
            effective_context_window_percent: 90,
          },
          {
            slug: 'hidden-model',
            visibility: 'hide',
            supported_in_api: true,
            supported_reasoning_levels: [],
          },
        ],
      })
    })

    expect(new URL(requestUrl).searchParams.get('client_version')).toBe(
      OPENAI_CODEX_CLIENT_VERSION,
    )
    expect(requestHeaders.get('Authorization')).toBe('Bearer catalog-access-token')
    expect(requestHeaders.get('ChatGPT-Account-Id')).toBe('acct_catalog')
    expect(requestHeaders.get('originator')).toBe('codex_cli_rs')
    expect(models).toEqual([
      {
        value: 'gpt-next-account-only',
        label: 'GPT Next',
        description: 'Account-scoped model',
        defaultReasoningEffort: 'xhigh',
        supportedReasoningEfforts: ['low', 'xhigh'],
        contextWindow: 360_000,
      },
    ])
  })

  test('falls back to the bundled GPT-5.6 catalog when the endpoint fails', async () => {
    const models = await getOpenAICodexModelCatalog({
      forceRefresh: true,
      fetchOverride: async () => new Response('unavailable', { status: 503 }),
    })

    expect(models.slice(0, 3).map((model) => model.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
  })
})
