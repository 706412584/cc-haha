import { afterEach, describe, expect, test } from 'bun:test'
import { StructuredIO } from '../structuredIO.js'
import {
  clearOAuthTokenCache,
  getClaudeAIOAuthTokens,
} from '../../utils/auth.js'
import {
  clearProxyCache,
  configureGlobalAgents,
  getProxyFetchOptions,
  getProxyUrl,
} from '../../utils/proxy.js'

describe('StructuredIO environment updates', () => {
  const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const originalNetworkEnv = Object.fromEntries(
    [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'http_proxy',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
      'NO_PROXY',
      'no_proxy',
    ].map(key => [key, process.env[key]]),
  )

  afterEach(() => {
    if (originalOAuthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
    }
    for (const [key, value] of Object.entries(originalNetworkEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearProxyCache()
    configureGlobalAgents()
    clearOAuthTokenCache()
  })

  test('clears OAuth token cache when CLAUDE_CODE_OAUTH_TOKEN changes at runtime', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'stale-env-token'
    clearOAuthTokenCache()
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('stale-env-token')

    async function* input() {
      yield `${JSON.stringify({
        type: 'update_environment_variables',
        variables: { CLAUDE_CODE_OAUTH_TOKEN: 'fresh-env-token' },
      })}\n`
    }

    const io = new StructuredIO(input())
    for await (const _message of io.structuredInput) {
      // update_environment_variables messages are consumed internally.
    }

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fresh-env-token')
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe('fresh-env-token')
  })

  test('reconfigures request routing when proxy variables change at runtime', async () => {
    const proxyUrl = 'http://127.0.0.1:17890'
    async function* input() {
      yield `${JSON.stringify({
        type: 'update_environment_variables',
        variables: {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          ALL_PROXY: proxyUrl,
          all_proxy: proxyUrl,
          NO_PROXY: 'localhost,127.0.0.1,::1',
          no_proxy: 'localhost,127.0.0.1,::1',
        },
      })}\n`
    }

    const io = new StructuredIO(input())
    for await (const _message of io.structuredInput) {
      // update_environment_variables messages are consumed internally.
    }

    expect(getProxyUrl()).toBe(proxyUrl)
    expect(getProxyFetchOptions({ targetUrl: 'https://api.openai.com' }).proxy).toBe(proxyUrl)
    expect(getProxyFetchOptions({ targetUrl: 'http://127.0.0.1:3456' }).proxy).toBeUndefined()
  })
})
