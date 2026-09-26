/**
 * Orchestration prompt preferences REST API
 *
 * GET    /api/orchestration-prompts        — read default/custom/effective for all three modes
 * PUT    /api/orchestration-prompts/:mode  — replace one mode's prompt
 * DELETE /api/orchestration-prompts/:mode  — drop the override, restoring the built-in prompt
 *
 * `:mode` is one of `coordinator` | `solo` | `re` — the three per-session
 * orchestration modes whose prompts the desktop composer can toggle.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  MAX_PROMPT_CHARS,
  assertOrchestrationPromptMode,
  orchestrationPromptPreferencesService,
} from '../services/orchestrationPromptPreferencesService.js'

export async function handleOrchestrationPromptsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  void url

  try {
    const modeSegment = segments[2]

    if (modeSegment === undefined) {
      if (req.method !== 'GET') throw methodNotAllowed(req.method)
      return Response.json({
        prompts: await orchestrationPromptPreferencesService.getAllPrompts(),
        maxChars: MAX_PROMPT_CHARS,
      })
    }

    const mode = assertOrchestrationPromptMode(modeSegment)

    if (req.method === 'PUT') {
      const body = await parseJsonBody(req)
      const text = body.text
      if (typeof text !== 'string') {
        throw ApiError.badRequest('Missing or invalid "text" in request body')
      }
      await orchestrationPromptPreferencesService.setPrompt(mode, text)
      // A whitespace-only body is treated as a reset, so report the state that
      // actually resulted rather than echoing the request.
      const resolved = await orchestrationPromptPreferencesService.getResolvedPrompt(mode)
      return Response.json({ ok: true, mode, isCustom: resolved.isCustom })
    }

    if (req.method === 'DELETE') {
      await orchestrationPromptPreferencesService.clearPrompt(mode)
      return Response.json({ ok: true, mode, isCustom: false })
    }

    throw methodNotAllowed(req.method)
  } catch (error) {
    return errorResponse(error)
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
