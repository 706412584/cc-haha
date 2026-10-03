import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getDefaultBaseUrl, setAuthToken, setBaseUrl } from './client'
import { voiceApi } from './voice'

const wav = new Blob([new Uint8Array(48)], { type: 'audio/wav' })
const options = { providerId: 'sensevoice-local', language: 'zh' } as const

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected transcribe to reject')
}

describe('voiceApi.transcribe', () => {
  afterEach(() => {
    setAuthToken(null)
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  it('posts the WAV as the raw body with the provider and language in the query', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    setAuthToken('token-1')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ text: 'hello', audioSeconds: 1, inferenceSeconds: 0.1 }),
    )

    await expect(voiceApi.transcribe(wav, options)).resolves.toEqual({
      text: 'hello',
      audioSeconds: 1,
      inferenceSeconds: 0.1,
    })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:49237/api/voice/transcribe?provider=sensevoice-local&language=zh')
    expect(init).toMatchObject({ method: 'POST', body: wav })
    expect(init!.headers).toMatchObject({ 'Content-Type': 'audio/wav', Authorization: 'Bearer token-1' })
  })

  it('keeps the error code from a JSON error body', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'voice/not-ready', message: 'not ready' }, { status: 409 }),
    )

    const error = await caught(voiceApi.transcribe(wav, options))

    expect(error.status).toBe(409)
    expect(error.body).toEqual({ error: 'voice/not-ready', message: 'not ready' })
  })

  it('keeps the status and raw text when the error body is not JSON', async () => {
    setBaseUrl('http://127.0.0.1:49237')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    )

    const error = await caught(voiceApi.transcribe(wav, options))

    expect(error.status).toBe(502)
    expect(error.body).toBe('<html>Bad Gateway</html>')
  })
})
