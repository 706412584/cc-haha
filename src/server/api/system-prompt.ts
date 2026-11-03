/**
 * Main system-prompt preferences REST API
 *
 * GET    /api/system-prompt  — read the override and the built-in static snapshot
 * PUT    /api/system-prompt  — replace the prompt (whitespace-only resets it)
 * DELETE /api/system-prompt  — drop the override, restoring the built-in prompt
 *
 * Distinct from `/api/orchestration-prompts`: that endpoint edits the three
 * per-mode ADDENDA, while this one replaces the session's base system prompt
 * wholesale via `--system-prompt-file`.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  MAX_SYSTEM_PROMPT_CHARS,
  systemPromptPreferencesService,
} from '../services/systemPromptPreferencesService.js'

export async function handleSystemPromptApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  void url
  void segments

  try {
    if (req.method === 'GET') {
      const [resolved, builtIn] = await Promise.all([
        systemPromptPreferencesService.getResolvedPrompt(),
        loadBuiltInSnapshot(),
      ])
      return Response.json({
        custom: resolved.custom,
        isCustom: resolved.isCustom,
        default: builtIn,
        maxChars: MAX_SYSTEM_PROMPT_CHARS,
      })
    }

    if (req.method === 'PUT') {
      const body = await parseJsonBody(req)
      const text = body.text
      if (typeof text !== 'string') {
        throw ApiError.badRequest('Missing or invalid "text" in request body')
      }
      await systemPromptPreferencesService.setPrompt(text)
      // A whitespace-only body is treated as a reset, so report the state that
      // actually resulted rather than echoing the request.
      const resolved = await systemPromptPreferencesService.getResolvedPrompt()
      return Response.json({ ok: true, isCustom: resolved.isCustom })
    }

    if (req.method === 'DELETE') {
      await systemPromptPreferencesService.clearPrompt()
      return Response.json({ ok: true, isCustom: false })
    }

    throw methodNotAllowed(req.method)
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * The built-in static snapshot lives in the CLI's prompt module, whose import
 * graph is large and feature-gated. Load it lazily, only on GET, and never let
 * a failure here turn the whole preferences read into an error — the editor can
 * still show the user's override.
 */
async function loadBuiltInSnapshot(): Promise<string> {
  try {
    const { getStaticSystemPromptSnapshot } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../constants/prompts.js') as typeof import('../../constants/prompts.js')
    return await getStaticSystemPromptSnapshot()
  } catch (error) {
    console.warn(
      `[system-prompt] Failed to build the built-in snapshot: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return ''
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('JSON body must be an object')
  }
  return body as Record<string, unknown>
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
