import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { traceCaptureService } from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleProxyRequest } from './handler.js'

/**
 * Fork customization: the relay must NOT strip the inbound `User-Agent` when
 * it identifies a programming client (e.g. `claude-cli/...`). Some upstream
 * providers (e.g. xingchiapi) whitelist specific clients and return
 * `403 client_not_allowed` when the request carries no recognizable UA. The
 * relay is a transparent proxy for the local CLI, so the CLI's identity is
 * part of the upstream contract and has to be forwarded as-is.
 *
 * Preset-declared `upstreamHeaders` still apply AFTER this pass-through and
 * can overwrite the UA — e.g. opencode-go still forces `cc-haha/$VERSION` —
 * so the pass-through is only about not stripping, not about preventing
 * intentional overrides.
 */
/** Minimal upstream response body in the protocol the relay is talking to. */
function upstreamBody(apiFormat: 'anthropic' | 'openai_chat' | 'openai_responses' | 'gemini') {
  if (apiFormat === 'openai_chat') return {
    id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: 'fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  if (apiFormat === 'openai_responses') return {
    id: 'resp_fixture', object: 'response', created_at: 0, model: 'fixture', status: 'completed',
    output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  if (apiFormat === 'gemini') return {
    candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  }
  return {
    id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture',
    content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }
}

describe('proxy relay forwards User-Agent to upstream providers', () => {
  let fixture: string
  let previous: string | undefined
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'ua-passthrough-handler-'))
    previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = fixture
    resetSettingsCache()
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    resetSettingsCache()
    await rm(fixture, { recursive: true, force: true })
  })

  async function captureUpstreamHeaders(
    inboundHeaders: Record<string, string>,
    apiFormat: 'anthropic' | 'openai_chat' | 'openai_responses' | 'gemini' = 'anthropic',
  ) {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Fixture',
      baseUrl: 'https://fixture.invalid',
      apiKey: 'fake-key',
      apiFormat,
      models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
      supportsNestedToolResultMedia: false,
    })
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    let upstreamHeaders: Headers | undefined
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      upstreamHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify(upstreamBody(apiFormat)), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    try {
      const request = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...inboundHeaders,
        },
        body: JSON.stringify({ model: 'fixture', max_tokens: 1024, messages: [{ role: 'user', content: 'fixture' }] }),
      })
      await handleProxyRequest(request, new URL(request.url))
      return upstreamHeaders
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  }

  test('forwards a claude-cli User-Agent instead of stripping it', async () => {
    const headers = await captureUpstreamHeaders({
      'User-Agent': 'claude-cli/2.1.288 (external, cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': 'fixture-session',
    })
    expect(headers?.get('user-agent')).toBe('claude-cli/2.1.288 (external, cli)')
  })

  test('still strips the other internal-client headers', async () => {
    const headers = await captureUpstreamHeaders({
      'User-Agent': 'claude-cli/2.1.288 (external, cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': 'fixture-session',
      'x-client-app': 'fixture-app',
    })
    expect(headers?.get('x-app')).toBeNull()
    expect(headers?.get('x-claude-code-session-id')).toBeNull()
    expect(headers?.get('x-client-app')).toBeNull()
  })

  test('forwards a non-claude-cli User-Agent verbatim as well', async () => {
    const headers = await captureUpstreamHeaders({
      'User-Agent': 'my-custom-agent/1.0',
    })
    expect(headers?.get('user-agent')).toBe('my-custom-agent/1.0')
  })

  // The CLI speaks Anthropic to the relay, but the upstream may speak OpenAI
  // Chat/Responses or Gemini. The protocol headers describe the client↔proxy
  // hop and must not leak, while the client identity MUST survive — gateways
  // whitelist on it exactly like on the native Messages path.
  test.each(['openai_chat', 'openai_responses', 'gemini'] as const)(
    'forwards the client identity across the %s protocol hop',
    async (apiFormat) => {
      const headers = await captureUpstreamHeaders({
        'User-Agent': 'claude-cli/2.1.288 (external, cli)',
        'X-Client-Name': 'Claude Code',
        'X-Client-Version': '2.1.288',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'fixture-beta',
        'x-stainless-lang': 'js',
        'x-app': 'cli',
        'x-claude-code-session-id': 'fixture-session',
      }, apiFormat)
      expect(headers?.get('user-agent')).toBe('claude-cli/2.1.288 (external, cli)')
      expect(headers?.get('x-client-name')).toBe('Claude Code')
      expect(headers?.get('x-client-version')).toBe('2.1.288')
      expect(headers?.get('anthropic-version')).toBeNull()
      expect(headers?.get('anthropic-beta')).toBeNull()
      expect(headers?.get('x-stainless-lang')).toBeNull()
      expect(headers?.get('x-app')).toBeNull()
      expect(headers?.get('x-claude-code-session-id')).toBeNull()
    },
  )
})
