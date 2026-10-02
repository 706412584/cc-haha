/**
 * Voice input REST API
 *
 * GET    /api/voice/catalog                     — providers, preferences, limits
 * PUT    /api/voice/preferences                 — partial update of { enabled, providerId, language, downloadSource }
 * POST   /api/voice/providers/:id/prepare       — start (or join) the background download
 * POST   /api/voice/providers/:id/cancel        — cancel a running download
 * GET    /api/voice/providers/:id/status        — provider info + preparation state
 * DELETE /api/voice/providers/:id/assets        — delete downloaded runtime and models
 * POST   /api/voice/transcribe?provider=&language= — raw 16 kHz mono PCM16 WAV body
 *
 * Voice errors use `{ error: 'voice/...', message }` with 400/404/409/500.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getVoiceService } from '../services/voice/defaultRegistry.js'
import { VoiceServiceError } from '../services/voice/errors.js'
import { isVoiceLanguage } from '../services/voice/preferences.js'
import { VOICE_LIMITS } from '../services/voice/types.js'
import type { VoiceService } from '../services/voice/voiceService.js'

export async function handleVoiceApi(
  req: Request,
  url: URL,
  segments: string[],
  service: VoiceService = getVoiceService(),
): Promise<Response> {
  try {
    const sub = segments[2]

    if (sub === 'catalog') {
      requireMethod(req, 'GET')
      return Response.json(await service.catalog())
    }

    if (sub === 'preferences') {
      requireMethod(req, 'PUT')
      const preferences = await service.updatePreferences(await parseJsonBody(req))
      return Response.json({ preferences })
    }

    if (sub === 'providers') {
      const providerId = segments[3] ? decodeProviderId(segments[3]) : undefined
      const action = segments[4]
      if (!providerId || !action) throw ApiError.notFound('Unknown voice provider endpoint')

      if (action === 'status') {
        requireMethod(req, 'GET')
        return Response.json(await service.status(providerId))
      }
      if (action === 'prepare') {
        requireMethod(req, 'POST')
        return Response.json(await service.prepare(providerId))
      }
      if (action === 'cancel') {
        requireMethod(req, 'POST')
        return Response.json(await service.cancel(providerId))
      }
      if (action === 'assets') {
        requireMethod(req, 'DELETE')
        return Response.json(await service.removeAssets(providerId))
      }
      throw ApiError.notFound(`Unknown voice provider endpoint: ${action}`)
    }

    if (sub === 'transcribe') {
      requireMethod(req, 'POST')
      const language = url.searchParams.get('language') ?? undefined
      if (language !== undefined && !isVoiceLanguage(language)) {
        throw ApiError.badRequest(`Unsupported language: ${language}`)
      }
      const wav = await readAudioBody(req)
      const transcript = await service.transcribe(
        url.searchParams.get('provider') ?? undefined,
        wav,
        language,
        req.signal,
      )
      return Response.json(transcript)
    }

    throw ApiError.notFound(`Unknown voice endpoint: ${sub}`)
  } catch (error) {
    if (error instanceof VoiceServiceError) {
      return Response.json(error.toBody(), { status: error.status })
    }
    return errorResponse(error)
  }
}

/** A malformed `%` escape can never name a registered provider; answer 404 rather than throwing a URIError. */
function decodeProviderId(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new VoiceServiceError('voice/unknown-provider', 'Unknown voice provider')
  }
}

/**
 * Reads the upload without buffering past the audio limit. The main server
 * accepts bodies far larger than a dictation clip, so the cap lives here.
 */
async function readAudioBody(req: Request): Promise<Uint8Array> {
  const max = VOICE_LIMITS.maxAudioBytes
  const tooLarge = () =>
    new VoiceServiceError('voice/invalid-audio', `Audio is too large (limit ${max} bytes)`)

  const declared = Number(req.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > max) throw tooLarge()
  if (!req.body) throw new VoiceServiceError('voice/invalid-audio', 'Audio body is empty')

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = req.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function requireMethod(req: Request, method: string): void {
  if (req.method !== method) {
    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  }
}
