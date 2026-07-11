/**
 * Skills Market — aggregation service.
 *
 * Merges the two upstream providers into a single paginated feed with
 * cross-source dedupe, per-source health/degradation reporting, TTL caching
 * (stale-while-error), and locally-computed install state.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { marketCache, getSourceHealth, MARKET_TTL } from './cache.js'
import { clawhubProvider } from './clawhubProvider.js'
import { skillhubProvider } from './skillhubProvider.js'
import {
  MARKET_LIMITS,
  MARKET_SOURCES,
  detectMarketLanguage,
  sanitizeDirName,
  skillId,
  type MarketFileContent,
  type MarketListResult,
  type MarketProvider,
  type MarketSource,
  type NormalizedSkill,
  type NormalizedSkillDetail,
  type ProviderListPage,
  type SourceStatusInfo,
} from './types.js'

export const MARKET_META_FILENAME = '.market-meta.json'

const providers: Record<MarketSource, MarketProvider> = {
  clawhub: clawhubProvider,
  skillhub: skillhubProvider,
}

// ─── Cursor (opaque, merges both providers' pagination) ─────────────────────

type MergedCursor = Partial<Record<MarketSource, string>>

export function encodeCursor(cursor: MergedCursor): string | null {
  const keys = Object.keys(cursor)
  if (keys.length === 0) return null
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url')
}

export function decodeCursor(raw: string | null | undefined): MergedCursor | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as MergedCursor
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const cursor: MergedCursor = {}
    for (const source of MARKET_SOURCES) {
      const value = parsed[source]
      if (typeof value === 'string' && value) cursor[source] = value
    }
    return cursor
  } catch {
    return undefined
  }
}

// ─── Install state annotation ────────────────────────────────────────────────

export function getMarketSkillsDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'skills')
}

export type MarketMeta = {
  id: string
  source: MarketSource
  slug: string
  version?: string
  installedAt: string
  fileCount: number
  signatureVerified?: boolean
}

export async function readMarketMeta(dirName: string): Promise<MarketMeta | null> {
  try {
    const raw = await fs.readFile(path.join(getMarketSkillsDir(), dirName, MARKET_META_FILENAME), 'utf-8')
    return JSON.parse(raw) as MarketMeta
  } catch {
    return null
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Computed fresh on every request (never cached): checks the local skills
 * directory for an existing install or a name conflict.
 */
export async function annotateInstallState<T extends NormalizedSkill>(skill: T): Promise<T> {
  const dirName = sanitizeDirName(skill.slug)
  if (!dirName) {
    return { ...skill, installState: 'not-installable', notInstallableReason: 'invalid-name' }
  }
  const target = path.join(getMarketSkillsDir(), dirName)
  if (!(await dirExists(target))) {
    return { ...skill, installState: 'installable', notInstallableReason: undefined, installedInfo: undefined }
  }
  const meta = await readMarketMeta(dirName)
  if (meta && meta.slug === skill.slug) {
    return {
      ...skill,
      installState: 'installed',
      notInstallableReason: undefined,
      installedInfo: { version: meta.version, installedAt: meta.installedAt, dirName },
    }
  }
  // Directory exists but was not installed from the market (or belongs to a
  // different skill) — refuse to overwrite it.
  return { ...skill, installState: 'not-installable', notInstallableReason: 'name-conflict' }
}

/** File-level installability checks — only possible once the file list is known. */
export function applyFileLimits(detail: NormalizedSkillDetail): NormalizedSkillDetail {
  const files = detail.files.map((f) => ({ ...f, tooBig: f.size > MARKET_LIMITS.maxFileSize }))
  const result: NormalizedSkillDetail = { ...detail, files }
  if (result.installState !== 'installable') return result
  if (files.length === 0 || !files.some((f) => f.path === 'SKILL.md')) {
    return { ...result, installState: 'not-installable', notInstallableReason: 'empty-file-list' }
  }
  if (files.length > MARKET_LIMITS.maxFileCount) {
    return { ...result, installState: 'not-installable', notInstallableReason: 'too-many-files' }
  }
  if (files.some((f) => f.tooBig) || result.totalSize > MARKET_LIMITS.maxTotalSize) {
    return { ...result, installState: 'not-installable', notInstallableReason: 'file-too-large' }
  }
  return result
}

// ─── Cross-source dedupe ─────────────────────────────────────────────────────

/**
 * SkillHub mirrors ClawHub skills (source='clawhub' + upstream_url). When a
 * page contains both the mirror and the ClawHub original, merge them: the
 * ClawHub entry wins (fresher data), enriched with SkillHub-only fields.
 */
export function dedupeSkills(items: NormalizedSkill[]): NormalizedSkill[] {
  const byClawhubSlug = new Map<string, NormalizedSkill>()
  for (const item of items) {
    if (item.source === 'clawhub') byClawhubSlug.set(item.slug, item)
  }
  const result: NormalizedSkill[] = []
  for (const item of items) {
    if (item.source === 'skillhub' && item.upstream?.slug) {
      const original = byClawhubSlug.get(item.upstream.slug)
      if (original) {
        original.mirrors = [...(original.mirrors ?? []), item.id]
        // Enrich the original with SkillHub-only data.
        if (!original.iconUrl && item.iconUrl) original.iconUrl = item.iconUrl
        if (original.securityStatus === 'unknown' && item.securityStatus !== 'unknown') {
          original.securityStatus = item.securityStatus
        }
        if (item.tags.length && original.tags.length === 0) original.tags = item.tags
        continue
      }
    }
    result.push(item)
  }
  return result
}

// ─── List / search ───────────────────────────────────────────────────────────

export type MarketListParams = {
  q?: string
  source: 'all' | MarketSource
  security?: string
  installed?: 'all' | 'installed' | 'installable'
  cursor?: string
  limit: number
}

type ProviderOutcome = {
  page: ProviderListPage | null
  status: SourceStatusInfo
}

async function fetchProviderPage(
  source: MarketSource,
  params: { q?: string; cursor?: string; limit: number },
): Promise<ProviderOutcome> {
  const isSearch = Boolean(params.q)
  const cacheKey = isSearch
    ? `search:${source}:${params.q}:${params.cursor ?? ''}:${params.limit}`
    : `list:${source}:${params.cursor ?? ''}:${params.limit}`
  const ttl = isSearch ? MARKET_TTL.search : MARKET_TTL.list

  const cached = marketCache.get<ProviderListPage>(cacheKey)
  if (cached) {
    return { page: cached, status: { status: 'ok', fetchedAt: Date.now(), fromCache: true } }
  }

  try {
    const page = isSearch
      ? await providers[source].search({ q: params.q!, cursor: params.cursor, limit: params.limit })
      : await providers[source].list({ cursor: params.cursor, limit: params.limit })
    marketCache.set(cacheKey, page, ttl)
    return { page, status: { status: 'ok', fetchedAt: Date.now(), fromCache: false } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Stale-while-error: fall back to an expired cache entry when available.
    const stale = marketCache.getStale<ProviderListPage>(cacheKey)
    if (stale) {
      return {
        page: stale.value,
        status: { status: 'cached', fetchedAt: stale.storedAt, fromCache: true, error: message },
      }
    }
    return { page: null, status: { ...getSourceHealth(source), fromCache: false, error: message } }
  }
}

export async function listMarketSkills(params: MarketListParams): Promise<MarketListResult> {
  const cursor = decodeCursor(params.cursor)
  const isFirstPage = !params.cursor
  const activeSources = params.source === 'all' ? MARKET_SOURCES : [params.source]

  const outcomes = new Map<MarketSource, ProviderOutcome>()
  await Promise.all(
    activeSources.map(async (source) => {
      // A source absent from a non-first-page cursor is exhausted.
      const providerCursor = cursor?.[source]
      if (!isFirstPage && !providerCursor) {
        outcomes.set(source, { page: { items: [] }, status: { status: 'ok', fromCache: true } })
        return
      }
      const limit = params.q && source === 'clawhub' ? MARKET_LIMITS.searchResultCap : params.limit
      outcomes.set(source, await fetchProviderPage(source, { q: params.q, cursor: providerCursor, limit }))
    }),
  )

  let merged: NormalizedSkill[] = []
  const nextCursor: MergedCursor = {}
  const sources = {} as Record<MarketSource, SourceStatusInfo>

  for (const source of MARKET_SOURCES) {
    const outcome = outcomes.get(source)
    if (!outcome) {
      sources[source] = { status: 'ok', fromCache: false }
      continue
    }
    sources[source] = outcome.status
    if (outcome.page) {
      merged.push(...outcome.page.items)
      if (outcome.page.nextCursor) nextCursor[source] = outcome.page.nextCursor
    }
  }

  merged = dedupeSkills(merged)
  merged.sort((a, b) => b.stats.downloads - a.stats.downloads)
  merged = await Promise.all(merged.map((item) => annotateInstallState(item)))

  if (params.security && params.security !== 'all') {
    merged = merged.filter((item) => item.securityStatus === params.security)
  }
  if (params.installed && params.installed !== 'all') {
    merged = merged.filter((item) =>
      params.installed === 'installed'
        ? item.installState === 'installed'
        : item.installState !== 'installed',
    )
  }

  return { items: merged, nextCursor: encodeCursor(nextCursor), sources }
}

// ─── Detail / file content ───────────────────────────────────────────────────

export async function getMarketSkillDetail(
  source: MarketSource,
  slug: string,
): Promise<{ skill: NormalizedSkillDetail; sourceStatus: SourceStatusInfo }> {
  const cacheKey = `detail:${source}:${slug}`
  let detail = marketCache.get<NormalizedSkillDetail>(cacheKey)
  let sourceStatus: SourceStatusInfo = { status: 'ok', fetchedAt: Date.now(), fromCache: true }

  if (!detail) {
    try {
      detail = await providers[source].detail(slug)
      marketCache.set(cacheKey, detail, MARKET_TTL.detail)
      sourceStatus = { status: 'ok', fetchedAt: Date.now(), fromCache: false }
    } catch (error) {
      const stale = marketCache.getStale<NormalizedSkillDetail>(cacheKey)
      if (!stale) throw error
      detail = stale.value
      sourceStatus = {
        status: 'cached',
        fetchedAt: stale.storedAt,
        fromCache: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const annotated = applyFileLimits(await annotateInstallState(detail))
  return { skill: annotated, sourceStatus }
}

export function isValidMarketFilePath(filePath: string): boolean {
  if (!filePath || filePath.length > 512) return false
  if (filePath.startsWith('/') || filePath.startsWith('\\')) return false
  if (filePath.includes('..') || filePath.includes('\0')) return false
  return true
}

export async function getMarketFileContent(
  source: MarketSource,
  slug: string,
  filePath: string,
): Promise<MarketFileContent> {
  const cacheKey = `file:${source}:${slug}:${filePath}`
  const cached = marketCache.get<MarketFileContent>(cacheKey)
  if (cached) return cached

  const fetched = await providers[source].fetchFile(slug, filePath)
  let content = fetched.content
  let truncated = false
  if (Buffer.byteLength(content, 'utf-8') > MARKET_LIMITS.previewTruncateBytes) {
    content = Buffer.from(content, 'utf-8').subarray(0, MARKET_LIMITS.previewTruncateBytes).toString('utf-8')
    truncated = true
  }
  const result: MarketFileContent = {
    path: filePath,
    content,
    language: detectMarketLanguage(filePath),
    size: fetched.size,
    truncated,
  }
  marketCache.set(cacheKey, result, MARKET_TTL.fileContent)
  return result
}

// ─── Status ──────────────────────────────────────────────────────────────────

export function getMarketStatus(): Record<MarketSource, SourceStatusInfo> {
  return {
    clawhub: getSourceHealth('clawhub'),
    skillhub: getSourceHealth('skillhub'),
  }
}

/** Look up a single skill (used by install) — detail path, bypassing list. */
export async function resolveMarketSkill(source: MarketSource, slug: string): Promise<NormalizedSkillDetail> {
  const { skill } = await getMarketSkillDetail(source, slug)
  return skill
}

export function marketSkillId(source: MarketSource, slug: string): string {
  return skillId(source, slug)
}
