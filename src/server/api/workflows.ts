/**
 * Dynamic workflows REST API
 *
 * GET    /api/workflows                        — list runnable workflow definitions
 * GET    /api/workflows/runs                   — list past runs (?sessionId=&limit=)
 * GET    /api/workflows/runs/:sessionId/:runId — one run: script, phases, agent results
 * GET    /api/workflows/session-runs/:sessionId — finished runs rebuilt from disk
 * POST   /api/workflows/validate               — parse + compile a script without running it
 * POST   /api/workflows/save                   — save a script as a /name command
 * GET    /api/workflows/:name                  — one definition, including its script
 * DELETE /api/workflows/:name                  — delete a saved workflow (?scope=user|project)
 *
 * Starting a run is deliberately not here: a run belongs to a conversation
 * turn, so the desktop sends the prompt (or `/name`) over the session
 * WebSocket and watches `task_progress` events for live phase/agent state.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  workflowService,
  type WorkflowSaveScope,
} from '../services/workflowService.js'

export async function handleWorkflowsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const first = segments[2] ? decodeURIComponent(segments[2]) : undefined

    if (method === 'GET' && !first) {
      const cwd = url.searchParams.get('cwd') ?? undefined
      const workflows = await workflowService.listDefinitions(cwd)
      return Response.json({ workflows })
    }

    if (method === 'GET' && first === 'runs' && !segments[3]) {
      const rawLimit = url.searchParams.get('limit')
      const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined
      const runs = await workflowService.listRuns({
        sessionId: url.searchParams.get('sessionId') ?? undefined,
        limit: Number.isSafeInteger(limit) && limit! > 0 ? limit : undefined,
      })
      return Response.json({ runs })
    }

    // Everything this session ever ran, rebuilt from disk. The desktop calls
    // this when a session is opened so a finished run is still visible.
    if (method === 'GET' && first === 'session-runs' && segments[3]) {
      const runs = await workflowService.reconstructSessionRuns(
        decodeURIComponent(segments[3]),
      )
      return Response.json({ runs })
    }

    if (method === 'GET' && first === 'runs' && segments[3] && segments[4]) {
      const run = await workflowService.getRun(
        decodeURIComponent(segments[3]),
        decodeURIComponent(segments[4]),
      )
      return Response.json(run)
    }

    if (method === 'POST' && first === 'validate') {
      const body = await readJson<{ script?: string }>(req)
      if (typeof body.script !== 'string') {
        throw ApiError.badRequest('`script` is required')
      }
      return Response.json(workflowService.validate(body.script))
    }

    if (method === 'POST' && first === 'save') {
      const body = await readJson<{
        script?: string
        name?: unknown
        scope?: string
        cwd?: string
      }>(req)
      if (typeof body.script !== 'string') {
        throw ApiError.badRequest('`script` is required')
      }
      if (body.name !== undefined && typeof body.name !== 'string') {
        throw ApiError.badRequest('`name` must be a string')
      }
      const saved = await workflowService.saveDefinition({
        script: body.script,
        scope: parseScope(body.scope),
        cwd: body.cwd,
        name: body.name,
      })
      return Response.json({ ok: true, ...saved })
    }

    if (method === 'GET' && first) {
      const cwd = url.searchParams.get('cwd') ?? undefined
      return Response.json(await workflowService.getDefinition(first, cwd))
    }

    if (method === 'DELETE' && first) {
      await workflowService.deleteDefinition(
        first,
        parseScope(url.searchParams.get('scope')),
        url.searchParams.get('cwd') ?? undefined,
      )
      return Response.json({ ok: true })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/workflows${first ? `/${first}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function parseScope(value: string | null | undefined): WorkflowSaveScope {
  if (value === 'project') return 'project'
  if (value === 'user' || value == null || value === '') return 'user'
  throw ApiError.badRequest(`Invalid scope: ${value}`)
}
