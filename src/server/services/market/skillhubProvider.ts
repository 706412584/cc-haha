/**
 * SkillHub provider (https://api.skillhub.cn)
 *
 * Endpoints (verified against the live API):
 *  - GET /api/skills?page=&pageSize=&keyword=      → {code, data:{skills[], total}, message}
 *      NOTE: pagination param MUST be `pageSize` (a `limit` param is silently ignored)
 *      NOTE: search param MUST be `keyword` (a `q` param is silently ignored)
 *  - GET /api/v1/skills/{slug}                     → {skill, owner, latestVersion, securityReports}
 *  - GET /api/v1/skills/{slug}/files               → {count, files:[{path, sha256, size}]}
 *  - GET /api/v1/skills/{slug}/file?path=          → 302 redirect to Tencent COS (follow)
 */

import { getProviderBase, providerFetch, providerFetchJson } from './providerFetch.js'
import {
  detectMarketLanguage,
  MARKET_ERROR_CODES,
  MarketUpstreamError,
  skillId,
  type MarketProvider,
  type NormalizedSkill,
  type NormalizedSkillDetail,
  type ProviderFileEntry,
  type ProviderListPage,
  type SecurityReport,
  type SecurityStatus,
} from './types.js'

type SkillhubListItem = {
  slug: string
  name?: string
  /** Detail endpoint uses displayName/summary/summary_zh instead of name/description/description_zh */
  displayName?: string
  summary?: string
  summary_zh?: string
  description?: string
  description_zh?: string
  category?: string
  subCategories?: Array<{ key?: string; name?: string }>
  downloads?: number
  installs?: number
  stars?: number
  iconUrl?: string
  ownerName?: string
  labels?: Record<string, string>
  source?: string
  upstream_url?: string
  verified?: boolean
  version?: string
  updated_at?: number
}

type SkillhubEnvelope<T> = { code: number; data: T; message?: string }

type SkillhubSecurityReports = Record<
  string,
  { status?: string; statusText?: string; reportUrl?: string } | undefined
>

type SkillhubDetail = {
  skill?: SkillhubListItem & { stats?: { downloads?: number; installs?: number; stars?: number } }
  owner?: { handle?: string; displayName?: string; image?: string }
  latestVersion?: { version?: string; changelog?: string }
  securityReports?: SkillhubSecurityReports
}

const BENIGN_STATUSES = new Set(['benign', 'safe', 'clean'])

function mapSecurity(
  reports: SkillhubSecurityReports | undefined,
  verified: boolean | undefined,
): { status: SecurityStatus; reports: SecurityReport[] } {
  const normalized: SecurityReport[] = []
  for (const [vendor, report] of Object.entries(reports ?? {})) {
    if (!report?.status) continue
    normalized.push({
      vendor,
      status: report.status,
      statusText: report.statusText || report.status,
      reportUrl: report.reportUrl,
    })
  }
  if (normalized.length === 0) return { status: 'unknown', reports: normalized }
  const anyFlagged = normalized.some((r) => !BENIGN_STATUSES.has(r.status.toLowerCase()))
  if (anyFlagged) return { status: 'flagged', reports: normalized }
  return { status: verified ? 'verified' : 'benign', reports: normalized }
}

function parseUpstream(item: SkillhubListItem): NormalizedSkill['upstream'] {
  if (item.source !== 'clawhub' || !item.upstream_url) return undefined
  // upstream_url looks like https://clawhub.ai/{owner}/{slug} — the trailing segment is the slug.
  try {
    const segments = new URL(item.upstream_url).pathname.split('/').filter(Boolean)
    const slug = segments[segments.length - 1]
    if (slug) return { source: 'clawhub', slug }
  } catch {
    // Malformed upstream URL — treat as a native entry.
  }
  return undefined
}

function normalizeListItem(item: SkillhubListItem): NormalizedSkill {
  const tags: string[] = []
  for (const sub of item.subCategories ?? []) {
    if (sub?.name) tags.push(sub.name)
  }
  return {
    id: skillId('skillhub', item.slug),
    source: 'skillhub',
    slug: item.slug,
    name: item.name || item.displayName || item.slug,
    summary: item.description_zh || item.description || item.summary_zh || item.summary || '',
    author: { handle: item.ownerName || '' },
    stats: {
      downloads: item.downloads ?? 0,
      installs: item.installs,
      stars: item.stars,
    },
    tags,
    category: item.category,
    version: item.version,
    updatedAt: item.updated_at,
    iconUrl: item.iconUrl || undefined,
    // List responses carry no security reports — `verified` is the only signal;
    // the detail endpoint refines this to benign/flagged via securityReports.
    securityStatus: item.verified ? 'verified' : 'unknown',
    requiresApiKey: item.labels?.requires_api_key === 'true',
    verified: item.verified,
    upstream: parseUpstream(item),
    installState: 'installable',
  }
}

async function fetchPage(params: { keyword?: string; page: number; pageSize: number }): Promise<ProviderListPage> {
  const base = getProviderBase('skillhub')
  const url = new URL('/api/skills', base)
  url.searchParams.set('page', String(params.page))
  url.searchParams.set('pageSize', String(params.pageSize))
  if (params.keyword) url.searchParams.set('keyword', params.keyword)

  const envelope = await providerFetchJson<SkillhubEnvelope<{ skills?: SkillhubListItem[]; total?: number }>>(
    'skillhub',
    url.toString(),
  )
  if (envelope.code !== 0 || !Array.isArray(envelope.data?.skills)) {
    throw new MarketUpstreamError(
      'skillhub',
      MARKET_ERROR_CODES.upstreamBadResponse,
      `skillhub responded code=${envelope.code}: ${envelope.message || 'bad payload'}`,
    )
  }
  const items = envelope.data.skills.filter((s) => s?.slug).map(normalizeListItem)
  const total = envelope.data.total ?? 0
  const hasMore = params.page * params.pageSize < total
  return {
    items,
    nextCursor: hasMore ? String(params.page + 1) : undefined,
    total,
  }
}

export const skillhubProvider: MarketProvider = {
  source: 'skillhub',

  async list({ cursor, limit }): Promise<ProviderListPage> {
    const page = cursor ? Math.max(1, Number.parseInt(cursor, 10) || 1) : 1
    return fetchPage({ page, pageSize: limit })
  },

  async search({ q, cursor, limit }): Promise<ProviderListPage> {
    const page = cursor ? Math.max(1, Number.parseInt(cursor, 10) || 1) : 1
    return fetchPage({ keyword: q, page, pageSize: limit })
  },

  async detail(slug): Promise<NormalizedSkillDetail> {
    const base = getProviderBase('skillhub')
    const data = await providerFetchJson<SkillhubDetail>(
      'skillhub',
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, base).toString(),
    )
    if (!data.skill?.slug) {
      throw new MarketUpstreamError('skillhub', MARKET_ERROR_CODES.upstreamBadResponse, 'skillhub detail missing skill')
    }

    const item = normalizeListItem(data.skill)
    if (data.skill.stats) {
      item.stats = {
        downloads: data.skill.stats.downloads ?? item.stats.downloads,
        installs: data.skill.stats.installs ?? item.stats.installs,
        stars: data.skill.stats.stars ?? item.stats.stars,
      }
    }
    const security = mapSecurity(data.securityReports, data.skill.verified)
    const version = data.latestVersion?.version || item.version

    let files: ProviderFileEntry[] = []
    try {
      files = await skillhubProvider.listFiles(slug)
    } catch {
      // File list is best-effort at detail time; install re-fetches it.
    }

    // SkillHub detail has no full SKILL.md body — fetch it for the overview tab.
    let description = ''
    const skillMd = files.find((f) => f.path === 'SKILL.md')
    if (skillMd) {
      try {
        const fetched = await skillhubProvider.fetchFile(slug, 'SKILL.md')
        description = fetched.content
      } catch {
        description = item.summary
      }
    } else {
      description = item.summary
    }

    return {
      ...item,
      version,
      author: {
        handle: data.owner?.handle || item.author.handle,
        displayName: data.owner?.displayName,
        avatarUrl: data.owner?.image || undefined,
      },
      securityStatus: security.status,
      securityReports: security.reports.length ? security.reports : undefined,
      description,
      files: files.map((f) => ({
        path: f.path,
        size: f.size,
        sha256: f.sha256,
        contentType: f.contentType,
        language: detectMarketLanguage(f.path),
        tooBig: false,
      })),
      totalSize: files.reduce((sum, f) => sum + (f.size || 0), 0),
    }
  },

  async listFiles(slug): Promise<ProviderFileEntry[]> {
    const base = getProviderBase('skillhub')
    const data = await providerFetchJson<{ count?: number; files?: Array<{ path: string; sha256?: string; size: number }> }>(
      'skillhub',
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}/files`, base).toString(),
    )
    if (!Array.isArray(data.files)) {
      throw new MarketUpstreamError('skillhub', MARKET_ERROR_CODES.upstreamBadResponse, 'skillhub files missing list')
    }
    return data.files
  },

  async fetchFile(slug, filePath): Promise<{ content: string; size: number }> {
    const base = getProviderBase('skillhub')
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, base)
    url.searchParams.set('path', filePath)
    // 302 → Tencent COS; providerFetch follows redirects.
    const res = await providerFetch('skillhub', url.toString())
    if (!res.ok) {
      throw new MarketUpstreamError(
        'skillhub',
        res.status === 404 ? MARKET_ERROR_CODES.upstreamBadResponse : MARKET_ERROR_CODES.upstreamError,
        `skillhub file fetch failed (${res.status})`,
      )
    }
    const content = await res.text()
    return { content, size: Buffer.byteLength(content, 'utf-8') }
  },
}
