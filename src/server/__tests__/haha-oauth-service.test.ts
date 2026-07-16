/**
 * Unit tests for HahaOAuthService — haha 自管 OAuth 的核心 service 层。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  HahaOAuthService,
  type StoredOAuthTokens,
} from '../services/hahaOAuthService.js'
import { SYSTEM_PROXY_URL_ENV } from '../services/networkSettings.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalSystemProxyUrl: string | undefined
let originalFetch: typeof globalThis.fetch
let service: HahaOAuthService

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haha-oauth-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalSystemProxyUrl = process.env[SYSTEM_PROXY_URL_ENV]
  originalFetch = globalThis.fetch
  delete process.env[SYSTEM_PROXY_URL_ENV]
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  service = new HahaOAuthService()
}

async function teardown() {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalSystemProxyUrl === undefined) {
    delete process.env[SYSTEM_PROXY_URL_ENV]
  } else {
    process.env[SYSTEM_PROXY_URL_ENV] = originalSystemProxyUrl
  }
  globalThis.fetch = originalFetch
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe('HahaOAuthService — file storage', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('loadTokens returns null when file does not exist', async () => {
    expect(await service.loadTokens()).toBeNull()
  })

  test('saveTokens writes file with 0600 permissions', async () => {
    const tokens: StoredOAuthTokens = {
      accessToken: 'sk-ant-oat01-xxx',
      refreshToken: 'sk-ant-ort01-xxx',
      expiresAt: Date.now() + 3600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    }
    await service.saveTokens(tokens)

    const oauthPath = path.join(tmpDir, 'cc-haha', 'oauth.json')
    const stat = await fs.stat(oauthPath)
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600)
    }

    const loaded = await service.loadTokens()
    expect(loaded).toEqual(tokens)
  })

  test('deleteTokens removes file', async () => {
    await service.saveTokens({
      accessToken: 'a',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      subscriptionType: null,
    })
    await service.deleteTokens()
    expect(await service.loadTokens()).toBeNull()
  })
})

describe('HahaOAuthService — session management', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('startSession creates session with PKCE + state', () => {
    const session = service.startSession({ serverPort: 54321 })
    expect(session.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session.authorizeUrl).toContain('code_challenge_method=S256')
    expect(session.authorizeUrl).toContain(`state=${encodeURIComponent(session.state)}`)
    expect(session.authorizeUrl).toContain('redirect_uri=')
    expect(session.authorizeUrl).toContain(encodeURIComponent(
      'http://localhost:54321/callback',
    ))
  })

  test('getSession returns stored session by state', () => {
    const session = service.startSession({ serverPort: 54321 })
    const found = service.getSession(session.state)
    expect(found?.codeVerifier).toBe(session.codeVerifier)
  })

  test('getSession returns null for unknown state', () => {
    expect(service.getSession('unknown-state')).toBeNull()
  })

  test('consumeSession removes session after fetch', () => {
    const session = service.startSession({ serverPort: 54321 })
    expect(service.consumeSession(session.state)).not.toBeNull()
    expect(service.getSession(session.state)).toBeNull()
  })

  test('completeSession stores subscription type fetched from profile info', async () => {
    process.env[SYSTEM_PROXY_URL_ENV] = 'http://127.0.0.1:17890'
    const session = service.startSession({ serverPort: 54321 })
    ;(service as any).exchangeWithCustomCallback = async () => ({
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      expires_in: 3600,
      scope: 'user:inference',
    })
    let profileProxyUrl: string | null | undefined
    service.setFetchProfileFn(async (_accessToken, options) => {
      profileProxyUrl = options?.proxyUrl
      return { subscriptionType: 'team' }
    })

    const tokens = await service.completeSession('authorization-code', session.state)

    expect(tokens.subscriptionType).toBe('team')
    expect(profileProxyUrl).toBe('http://127.0.0.1:17890')
    expect((await service.loadTokens())?.subscriptionType).toBe('team')
  })

  test('routes the Claude token exchange through the dynamic system proxy bridge', async () => {
    const bridgeUrl = 'http://127.0.0.1:17890'
    process.env[SYSTEM_PROXY_URL_ENV] = bridgeUrl
    let requestProxy: string | undefined
    globalThis.fetch = (async (_input, init) => {
      requestProxy = (init as RequestInit & { proxy?: string } | undefined)?.proxy
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        scope: 'user:inference',
      })
    }) as typeof fetch

    await (service as any).exchangeWithCustomCallback(
      'authorization-code',
      'state',
      'verifier',
      54321,
    )

    expect(requestProxy).toBe(bridgeUrl)
  })
})

describe('HahaOAuthService — ensureFreshAccessToken', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('returns null when no token file exists', async () => {
    expect(await service.ensureFreshAccessToken()).toBeNull()
  })

  test('returns token unchanged if not expired', async () => {
    const tokens: StoredOAuthTokens = {
      accessToken: 'still-valid',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    }
    await service.saveTokens(tokens)

    expect(await service.ensureFreshAccessToken()).toBe('still-valid')
  })

  test('refreshes token when expired (within 5-min buffer)', async () => {
    process.env[SYSTEM_PROXY_URL_ENV] = 'http://127.0.0.1:17890'
    const oldTokens: StoredOAuthTokens = {
      accessToken: 'expired',
      refreshToken: 'refresh-xxx',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    }
    await service.saveTokens(oldTokens)

    let refreshProxyUrl: string | null | undefined
    service.setRefreshFn(async (_refreshToken, options) => {
      refreshProxyUrl = options?.proxyUrl
      return {
        accessToken: 'new-fresh-token',
        refreshToken: 'new-refresh-xxx',
        expiresAt: Date.now() + 3600_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: null,
      }
    })

    const fresh = await service.ensureFreshAccessToken()
    expect(fresh).toBe('new-fresh-token')
    expect(refreshProxyUrl).toBe('http://127.0.0.1:17890')

    const loaded = await service.loadTokens()
    expect(loaded?.accessToken).toBe('new-fresh-token')
  })

  test('returns null when refresh fails', async () => {
    await service.saveTokens({
      accessToken: 'expired',
      refreshToken: 'bad-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: null,
    })
    service.setRefreshFn(async () => {
      throw new Error('401 Unauthorized')
    })

    expect(await service.ensureFreshAccessToken()).toBeNull()
  })
})
