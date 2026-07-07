import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
  MAX_AI_REQUEST_TIMEOUT_MS,
  MIN_AI_REQUEST_TIMEOUT_MS,
  getManualNetworkProxyUrl,
  buildNetworkEnvironment,
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
  normalizeNetworkSettings,
} from '../services/networkSettings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'network-settings-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  resetSettingsCache()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

describe('network settings', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('normalizes missing settings to the 600s direct-proxy default', () => {
    expect(normalizeNetworkSettings({})).toEqual({
      aiRequestTimeoutMs: DEFAULT_AI_REQUEST_TIMEOUT_MS,
      proxy: {
        mode: 'direct',
        url: '',
      },
    })
  })

  it('clears inherited proxy environment for direct provider requests', () => {
    const settings = normalizeNetworkSettings({
      network: {
        proxy: {
          mode: 'direct',
          url: '',
        },
      },
    })

    expect(buildNetworkEnvironment(settings, {
      HTTP_PROXY: 'http://127.0.0.1:1181',
      HTTPS_PROXY: 'http://127.0.0.1:1181',
      http_proxy: 'http://127.0.0.1:1181',
      https_proxy: 'http://127.0.0.1:1181',
    })).toMatchObject({
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
    })
    expect(getNetworkProxyFetchOptions(settings, 'https://api.example.com/v1/messages').proxy).toBeUndefined()
  })

  it('keeps inherited process proxy for explicit system provider requests', () => {
    const settings = normalizeNetworkSettings({
      network: {
        proxy: {
          mode: 'system',
          url: '',
        },
      },
    })

    const originalHttpProxy = process.env.HTTP_PROXY
    const originalHttpsProxy = process.env.HTTPS_PROXY
    const originalLowerHttpProxy = process.env.http_proxy
    const originalLowerHttpsProxy = process.env.https_proxy
    process.env.HTTP_PROXY = 'http://127.0.0.1:1181'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1181'
    delete process.env.http_proxy
    delete process.env.https_proxy
    try {
      expect(buildNetworkEnvironment(settings)).toEqual({
        API_TIMEOUT_MS: String(DEFAULT_AI_REQUEST_TIMEOUT_MS),
      })
      expect(getNetworkProxyFetchOptions(settings, 'https://api.example.com/v1/messages').proxy)
        .toBe('http://127.0.0.1:1181')
    } finally {
      if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = originalHttpProxy
      if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = originalHttpsProxy
      if (originalLowerHttpProxy === undefined) delete process.env.http_proxy
      else process.env.http_proxy = originalLowerHttpProxy
      if (originalLowerHttpsProxy === undefined) delete process.env.https_proxy
      else process.env.https_proxy = originalLowerHttpsProxy
    }
  })

  it('clamps AI request timeouts and trims manual proxy URLs', () => {
    expect(normalizeNetworkSettings({
      network: {
        aiRequestTimeoutMs: 9_999_999,
        proxy: {
          mode: 'manual',
          url: '  http://127.0.0.1:7890  ',
        },
      },
    })).toEqual({
      aiRequestTimeoutMs: MAX_AI_REQUEST_TIMEOUT_MS,
      proxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })

    expect(normalizeNetworkSettings({
      network: {
        aiRequestTimeoutMs: 100,
      },
    }).aiRequestTimeoutMs).toBe(MIN_AI_REQUEST_TIMEOUT_MS)
  })

  it('loads persisted user network settings for provider requests', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          aiRequestTimeoutMs: 180_000,
          proxy: {
            mode: 'manual',
            url: ' http://127.0.0.1:7890 ',
          },
        },
      }),
      'utf-8',
    )

    const settings = await loadNetworkSettings()

    expect(settings.aiRequestTimeoutMs).toBe(180_000)
    expect(getManualNetworkProxyUrl(settings)).toBe('http://127.0.0.1:7890')
    expect(buildNetworkEnvironment(settings)).toEqual({
      API_TIMEOUT_MS: '180000',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    })
  })

  it('preserves custom no_proxy entries while adding loopback bypasses for manual proxies', () => {
    const settings = normalizeNetworkSettings({
      network: {
        proxy: {
          mode: 'manual',
          url: 'http://proxy.example:8080',
        },
      },
    })

    expect(buildNetworkEnvironment(settings, { no_proxy: '.corp.local,10.0.0.0/8' })).toMatchObject({
      NO_PROXY: '.corp.local,10.0.0.0/8,localhost,127.0.0.1,::1',
      no_proxy: '.corp.local,10.0.0.0/8,localhost,127.0.0.1,::1',
    })
  })

  it('preserves authenticated manual proxy URLs for provider requests', () => {
    const settings = normalizeNetworkSettings({
      network: {
        proxy: {
          mode: 'manual',
          url: ' https://user:p%40ss@proxy.example.com:8443 ',
        },
      },
    })

    expect(getManualNetworkProxyUrl(settings)).toBe('https://user:p%40ss@proxy.example.com:8443')
    expect(buildNetworkEnvironment(settings)).toMatchObject({
      HTTP_PROXY: 'https://user:p%40ss@proxy.example.com:8443',
      HTTPS_PROXY: 'https://user:p%40ss@proxy.example.com:8443',
    })
  })
})
