/**
 * Skills Market — shared upstream fetch helper.
 *
 * Every upstream request goes through providerFetch: 10s timeout, one retry,
 * network-proxy settings, source-health bookkeeping, and env-based test hooks
 * (HAHA_MARKET_DISABLE_PROVIDERS / HAHA_MARKET_BASE_CLAWHUB / HAHA_MARKET_BASE_SKILLHUB).
 */

import {
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
} from '../networkSettings.js'
import { recordSourceFailure, recordSourceSuccess } from './cache.js'
import { MARKET_ERROR_CODES, MarketUpstreamError, type MarketSource } from './types.js'

const DEFAULT_BASES: Record<MarketSource, string> = {
  clawhub: 'https://clawhub.ai',
  skillhub: 'https://api.skillhub.cn',
}

const REQUEST_TIMEOUT_MS = 10_000

export function getProviderBase(source: MarketSource): string {
  const envKey = source === 'clawhub' ? 'HAHA_MARKET_BASE_CLAWHUB' : 'HAHA_MARKET_BASE_SKILLHUB'
  return process.env[envKey] || DEFAULT_BASES[source]
}

export function isProviderDisabled(source: MarketSource): boolean {
  const disabled = process.env.HAHA_MARKET_DISABLE_PROVIDERS
  if (!disabled) return false
  return disabled.split(',').map((s) => s.trim()).includes(source)
}

async function fetchOnce(source: MarketSource, url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    let proxyOptions: Record<string, unknown> = {}
    try {
      const settings = await loadNetworkSettings()
      proxyOptions = getNetworkProxyFetchOptions(settings, url) as Record<string, unknown>
    } catch {
      // Proxy settings unavailable — fall back to a direct request.
    }
    return await fetch(url, {
      headers: { Accept: 'application/json, text/plain, */*' },
      redirect: 'follow',
      signal: controller.signal,
      ...proxyOptions,
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function providerFetch(source: MarketSource, url: string): Promise<Response> {
  if (isProviderDisabled(source)) {
    const error = new MarketUpstreamError(source, MARKET_ERROR_CODES.upstreamError, `${source} provider disabled`)
    recordSourceFailure(source, error.message)
    throw error
  }

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchOnce(source, url)
      if (res.status === 429 || res.status >= 500) {
        lastError = new MarketUpstreamError(
          source,
          MARKET_ERROR_CODES.upstreamError,
          `${source} responded ${res.status}`,
        )
        continue
      }
      recordSourceSuccess(source)
      return res
    } catch (error) {
      if (error instanceof MarketUpstreamError) {
        lastError = error
        continue
      }
      const isAbort = error instanceof Error && error.name === 'AbortError'
      lastError = new MarketUpstreamError(
        source,
        isAbort ? MARKET_ERROR_CODES.upstreamTimeout : MARKET_ERROR_CODES.upstreamError,
        isAbort ? `${source} request timed out` : `${source} request failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const finalError = lastError instanceof MarketUpstreamError
    ? lastError
    : new MarketUpstreamError(source, MARKET_ERROR_CODES.upstreamError, `${source} request failed`)
  recordSourceFailure(source, finalError.message)
  throw finalError
}

export async function providerFetchJson<T>(source: MarketSource, url: string): Promise<T> {
  const res = await providerFetch(source, url)
  if (!res.ok) {
    const error = new MarketUpstreamError(
      source,
      MARKET_ERROR_CODES.upstreamError,
      `${source} responded ${res.status} for ${new URL(url).pathname}`,
    )
    recordSourceFailure(source, error.message)
    throw error
  }
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    const error = new MarketUpstreamError(
      source,
      MARKET_ERROR_CODES.upstreamBadResponse,
      `${source} returned invalid JSON`,
    )
    recordSourceFailure(source, error.message)
    throw error
  }
}
