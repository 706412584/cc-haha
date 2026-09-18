import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from '../services/providerService.js'
import { traceCaptureService } from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleProxyRequest } from './handler.js'

/**
 * A dropped connection carries no HTTP response, so the transport code and the
 * endpoint that failed are the only diagnostics that exist. Flattening the
 * error to `err.message` left sessions reporting an undiagnosable "socket
 * connection was closed unexpectedly" — nothing distinguished a provider
 * outage from a local network fault from a request the gateway rejected.
 */
describe('proxy upstream connection failures keep their diagnostics', () => {
  let fixture: string
  let previous: string | undefined
  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'upstream-failure-handler-'))
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

  async function proxyWithFailingFetch(apiFormat: 'anthropic' | 'openai_chat', error: unknown) {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Fixture',
      baseUrl: 'https://fixture.invalid',
      apiKey: 'fake-key',
      apiFormat,
      models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
      ...(apiFormat === 'anthropic' ? { supportsNestedToolResultMedia: false } : {}),
    })
    // The proxy records the failure asynchronously, after the response is
    // returned. Stub the trace sink: a real write would race the fixture
    // directory teardown in afterEach and surface as an unhandled ENOENT
    // between tests.
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw error
    })
    try {
      const request = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'upstream-failure' },
        body: JSON.stringify({ model: 'fixture', max_tokens: 1024, messages: [{ role: 'user', content: 'fixture' }] }),
      })
      const response = await handleProxyRequest(request, new URL(request.url))
      return { status: response.status, body: await response.json() as { error?: { type?: string; message?: string } } }
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  }

  for (const apiFormat of ['anthropic', 'openai_chat'] as const) {
    test(`${apiFormat}: a reset connection reports its code and the upstream url`, async () => {
      const cause = Object.assign(new Error('The socket connection was closed unexpectedly.'), {
        code: 'ECONNRESET',
        errno: 0,
      })

      const { status, body } = await proxyWithFailingFetch(apiFormat, cause)

      // Status and type stay 5xx/api_error: withRetry treats a 5xx api_error
      // body as retryable, which is the point of a dropped connection.
      expect(status).toBe(502)
      expect(body.error?.type).toBe('api_error')
      expect(body.error?.message).toContain('The socket connection was closed unexpectedly.')
      expect(body.error?.message).toContain('code=ECONNRESET')
      expect(body.error?.message).toContain('url=https://fixture.invalid')
      // Bun reports errno 0 for every transport failure; it is a placeholder,
      // not a POSIX value, and would read as "success".
      expect(body.error?.message).not.toContain('errno=')
    })
  }

  test('finds the transport code through the SDK cause chain', async () => {
    const root = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
      errno: -4078,
    })
    const wrapped = new Error('fetch failed', { cause: root })

    const { body } = await proxyWithFailingFetch('anthropic', wrapped)

    expect(body.error?.message).toContain('code=ECONNREFUSED')
    // A real non-zero errno is still reported.
    expect(body.error?.message).toContain('errno=-4078')
  })

  // Bun echoes the full request URL in some transport errors, and the message
  // is appended verbatim — appending a redacted url= after an unredacted
  // message would leak exactly what the redaction exists to remove.
  test('redacts urls echoed inside the upstream error message', async () => {
    const leaked =
      'UnsupportedProxyProtocol fetching "https://alice:s3cr3t@relay.example.com/anthropic?api_key=sk-live-LEAKED/v1/messages".'
    const error = Object.assign(new Error(leaked), { code: 'UnsupportedProxyProtocol' })

    const { body } = await proxyWithFailingFetch('anthropic', error)
    const message = body.error?.message ?? ''

    expect(message).toContain('code=UnsupportedProxyProtocol')
    expect(message).toContain('relay.example.com')
    expect(message).not.toContain('s3cr3t')
    expect(message).not.toContain('alice')
    expect(message).not.toContain('sk-live-LEAKED')
  })

  // A URL with no authority (`file://`) has an empty host, so collapsing to
  // the host would leave its path — which may embed a credential — as the
  // remainder of the match.
  test('drops the path of a schemeless-authority url instead of leaving it behind', async () => {
    const error = Object.assign(
      new Error('failed to read "file:///home/alice/.config/relay/token-LEAKED" while connecting'),
      { code: 'ECONNRESET' },
    )

    const { body } = await proxyWithFailingFetch('anthropic', error)
    const message = body.error?.message ?? ''

    expect(message).toContain('[redacted-url]')
    expect(message).not.toContain('token-LEAKED')
    expect(message).not.toContain('alice')
  })

  test('omits diagnostics the error does not carry instead of inventing them', async () => {
    const { status, body } = await proxyWithFailingFetch('anthropic', new Error('transform exploded'))

    expect(status).toBe(502)
    expect(body.error?.message).toBe('transform exploded (url=https://fixture.invalid/v1/messages)')
  })

  // The message is persisted to the transcript, the diagnostics log, and the UI.
  // A user-supplied baseUrl can carry credentials and query secrets, neither of
  // which helps diagnose a dropped connection.
  test('does not leak credentials from the upstream url', async () => {
    const provider = await new ProviderService().addProvider({
      presetId: 'custom',
      name: 'Fixture',
      baseUrl: 'https://alice:s3cr3t@fixture.invalid/base?api_key=leaked',
      apiKey: 'fake-key',
      apiFormat: 'anthropic',
      models: { main: 'fixture', haiku: 'fixture', sonnet: 'fixture', opus: 'fixture' },
      supportsNestedToolResultMedia: false,
    })
    const callMock = spyOn(traceCaptureService, 'recordCall').mockResolvedValue(null)
    const eventMock = spyOn(traceCaptureService, 'recordEvent').mockResolvedValue(null)
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw Object.assign(new Error('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' })
    })
    try {
      const request = new Request(`http://localhost/proxy/providers/${provider.id}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fixture', max_tokens: 1024, messages: [{ role: 'user', content: 'x' }] }),
      })
      const response = await handleProxyRequest(request, new URL(request.url))
      const body = await response.json() as { error?: { message?: string } }
      const message = body.error?.message ?? ''

      expect(message).toContain('code=ECONNRESET')
      // Scheme, host, and path survive; userinfo and the query do not.
      expect(message).toContain('url=https://fixture.invalid/base')
      expect(message).not.toContain('s3cr3t')
      expect(message).not.toContain('alice')
      expect(message).not.toContain('leaked')
    } finally {
      fetchMock.mockRestore()
      callMock.mockRestore()
      eventMock.mockRestore()
    }
  })
})
