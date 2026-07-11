/**
 * Skills Market REST API
 *
 * GET  /api/market/skills                       — aggregated list/search across sources
 *        ?q=&source=all|clawhub|skillhub&security=&installed=&cursor=&limit=
 * GET  /api/market/skills/{source}/{slug}       — full detail (description, files, security)
 * GET  /api/market/skills/{source}/{slug}/file  — file content ?path=SKILL.md
 * POST /api/market/install                      — body {id: "source:slug"}
 * POST /api/market/uninstall                    — body {id: "source:slug"}
 * GET  /api/market/status                       — per-source health
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { installMarketSkill, uninstallMarketSkill } from '../services/market/installService.js'
import {
  getMarketFileContent,
  getMarketSkillDetail,
  getMarketStatus,
  isValidMarketFilePath,
  listMarketSkills,
} from '../services/market/marketService.js'
import {
  MARKET_ERROR_CODES,
  MARKET_SOURCES,
  MarketUpstreamError,
  parseSkillId,
  type MarketSource,
} from '../services/market/types.js'

const VALID_SECURITY = new Set(['all', 'verified', 'benign', 'unknown', 'flagged'])
const VALID_INSTALLED = new Set(['all', 'installed', 'installable'])

function parseSource(raw: string | null): 'all' | MarketSource {
  if (!raw || raw === 'all') return 'all'
  if (MARKET_SOURCES.includes(raw as MarketSource)) return raw as MarketSource
  throw ApiError.badRequest(`Invalid source: ${raw}`)
}

function parsePathSource(raw: string | undefined): MarketSource {
  if (raw && MARKET_SOURCES.includes(raw as MarketSource)) return raw as MarketSource
  throw ApiError.badRequest(`Invalid market source: ${raw ?? ''}`)
}

function parseSlug(raw: string | undefined): string {
  if (!raw) throw ApiError.badRequest('Missing skill slug')
  const slug = decodeURIComponent(raw)
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw ApiError.badRequest(`Invalid skill slug: ${slug}`)
  }
  return slug
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as Record<string, unknown>
    if (typeof body !== 'object' || body === null) throw new Error('not an object')
    return body
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function parseIdFromBody(body: Record<string, unknown>): { source: MarketSource; slug: string } {
  const id = typeof body.id === 'string' ? body.id : ''
  const parsed = parseSkillId(id)
  if (!parsed) throw ApiError.badRequest(`Invalid skill id: ${id || '(missing)'}`)
  return parsed
}

export async function handleMarketApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const sub = segments[2]

    if (method === 'GET' && sub === 'skills' && !segments[3]) {
      const limitRaw = Number.parseInt(url.searchParams.get('limit') || '24', 10)
      const limit = Math.min(100, Math.max(1, Number.isNaN(limitRaw) ? 24 : limitRaw))
      const security = url.searchParams.get('security') || 'all'
      const installed = url.searchParams.get('installed') || 'all'
      if (!VALID_SECURITY.has(security)) throw ApiError.badRequest(`Invalid security filter: ${security}`)
      if (!VALID_INSTALLED.has(installed)) throw ApiError.badRequest(`Invalid installed filter: ${installed}`)

      const result = await listMarketSkills({
        q: url.searchParams.get('q')?.trim() || undefined,
        source: parseSource(url.searchParams.get('source')),
        security,
        installed: installed as 'all' | 'installed' | 'installable',
        cursor: url.searchParams.get('cursor') || undefined,
        limit,
      })
      return Response.json(result)
    }

    if (method === 'GET' && sub === 'skills' && segments[3] && segments[4] && !segments[5]) {
      const source = parsePathSource(segments[3])
      const slug = parseSlug(segments[4])
      const { skill, sourceStatus } = await getMarketSkillDetail(source, slug)
      return Response.json({ skill, sourceStatus })
    }

    if (method === 'GET' && sub === 'skills' && segments[3] && segments[4] && segments[5] === 'file') {
      const source = parsePathSource(segments[3])
      const slug = parseSlug(segments[4])
      const filePath = url.searchParams.get('path') || ''
      if (!isValidMarketFilePath(filePath)) {
        throw ApiError.badRequest(`Invalid file path: ${filePath}`)
      }
      const file = await getMarketFileContent(source, slug, filePath)
      return Response.json({ file })
    }

    if (method === 'GET' && sub === 'status') {
      return Response.json({ sources: getMarketStatus() })
    }

    if (method === 'POST' && sub === 'install') {
      const { source, slug } = parseIdFromBody(await parseJsonBody(req))
      const result = await installMarketSkill(source, slug)
      return Response.json({ ok: true, installedPath: result.installedPath, skill: result.skill })
    }

    if (method === 'POST' && sub === 'uninstall') {
      const { source, slug } = parseIdFromBody(await parseJsonBody(req))
      const result = await uninstallMarketSkill(source, slug)
      return Response.json({ ok: true, removedPath: result.removedPath, skill: result.skill })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/market${sub ? `/${sub}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    if (error instanceof MarketUpstreamError) {
      const status = error.code === MARKET_ERROR_CODES.upstreamBadResponse ? 404 : 502
      return errorResponse(new ApiError(status, error.message, error.code))
    }
    return errorResponse(error)
  }
}
