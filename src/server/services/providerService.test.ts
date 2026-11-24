/**
 * The "test connection" and "fetch models" probes call the upstream directly
 * instead of going through the proxy. A gateway that gates on the client
 * identity (agentrouter, xingchiapi) therefore needs the provider's own
 * `customHeaders` on the probe too, or the probe reports a false 401 for a
 * provider whose real chat works.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ProviderService } from './providerService.js'

type FetchCall = { url: string; init: RequestInit | undefined }

let tmpDir: string
let originalFetch: typeof globalThis.fetch
let originalConfigDir: string | undefined
let calls: FetchCall[]

/** Answer every probe with 401 so `testProviderConfig` stops after step 1. */
function stubRejectingFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    return Response.json({ error: { message: 'client rejected' } }, { status: 401 })
  }) as typeof globalThis.fetch
}

const probe = (customHeaders?: string) => ({
  baseUrl: 'https://agentrouter.org/v1',
  apiKey: 'sk-test-key-123456',
  modelId: 'gpt-6.1-sol',
  apiFormat: 'openai_chat' as const,
  ...(customHeaders === undefined ? {} : { customHeaders }),
})

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'provider-service-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  originalFetch = globalThis.fetch
  calls = []
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(tmpDir, { recursive: true, force: true })
})

describe('testProviderConfig custom headers', () => {
  test('sends the provider customHeaders on the direct probe', async () => {
    stubRejectingFetch()

    const result = await new ProviderService().testProviderConfig(
      probe('user-agent: codex_cli_rs/0.20.0 (external; cli)'),
    )

    expect(result.connectivity.success).toBe(false)
    expect(calls.length).toBe(1)
    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('user-agent')).toBe('codex_cli_rs/0.20.0 (external; cli)')
    // The probe credential is written after the declared headers and wins.
    expect(headers.get('authorization')).toBe('Bearer sk-test-key-123456')
  })

  test('omits the header entirely when customHeaders is absent or blank', async () => {
    stubRejectingFetch()

    await new ProviderService().testProviderConfig(probe())
    await new ProviderService().testProviderConfig(probe('   \n  '))

    expect(calls.length).toBe(2)
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('user-agent')).toBeNull()
    }
  })

  test('the user header wins over a preset-declared one without duplicating it', async () => {
    // opencode-go declares `User-Agent: cc-haha/$VERSION`; a user that needs a
    // different identity must be able to replace it, and only one value may
    // reach the wire (Headers would otherwise join them with a comma).
    stubRejectingFetch()

    await new ProviderService().testProviderConfig({
      ...probe('User-Agent: codex_cli_rs/0.20.0 (external; cli)'),
      presetId: 'opencode-go',
    })

    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('user-agent')).toBe('codex_cli_rs/0.20.0 (external; cli)')
    expect(headers.get('user-agent')).not.toContain(',')
  })

  test('a credential-shaped custom header cannot replace the probe credential', async () => {
    stubRejectingFetch()

    await new ProviderService().testProviderConfig(
      probe('Authorization: Bearer attacker\nx-api-key: attacker'),
    )

    const headers = new Headers(calls[0]!.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-test-key-123456')
    expect(headers.get('x-api-key')).toBeNull()
  })
})