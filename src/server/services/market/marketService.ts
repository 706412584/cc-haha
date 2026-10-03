/**
 * Skills Market — aggregation service.
 *
 * The default `catalog` scope pages through the curated snapshot shipped with
 * the app (no network). The `market` scope merges the two upstream providers
 * into a single paginated feed with cross-source dedupe, per-source
 * health/degradation reporting, TTL caching (stale-while-error), and
 * locally-computed install state.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { marketCache, getSourceHealth, MARKET_TTL } from './cache.js'
import {
  catalogCategories,
  catalogClawhubOwners,
  catalogEntryFor,
  catalogEntryToSkill,
  filterCatalog,
  getCatalog,
} from './catalog/catalog.js'
import { clawhubProvider, setClawhubOwnerHints, withClawhubOwner } from './clawhubProvider.js'
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
  type MarketScope,
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

// Catalog entries name an exact ClawHub owner; detail, files and install must
// resolve the same skill the card showed.
setClawhubOwnerHints(catalogClawhubOwners())

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

export function parseMarketMeta(value: unknown): MarketMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>
  const source = candidate.source
  const slug = candidate.slug
  const id = candidate.id
  const installedAt = candidate.installedAt
  const fileCount = candidate.fileCount
  const version = candidate.version
  const signatureVerified = candidate.signatureVerified

  if (typeof source !== 'string' || !MARKET_SOURCES.includes(source as MarketSource)) return null
  if (typeof slug !== 'string' || !slug || !sanitizeDirName(slug)) return null
  if (id !== skillId(source as MarketSource, slug)) return null
  if (typeof installedAt !== 'string' || !installedAt) return null
  if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0) return null
  if (version !== undefined && typeof version !== 'string') return null
  if (signatureVerified !== undefined && typeof signatureVerified !== 'boolean') return null

  return {
    id,
    source: source as MarketSource,
    slug,
    installedAt,
    fileCount,
    ...(version === undefined ? {} : { version }),
    ...(signatureVerified === undefined ? {} : { signatureVerified }),
  }
}

export async function readMarketMeta(dirName: string): Promise<MarketMeta | null> {
  try {
    const raw = await fs.readFile(path.join(getMarketSkillsDir(), dirName, MARKET_META_FILENAME), 'utf-8')
    const meta = parseMarketMeta(JSON.parse(raw))
    return meta && sanitizeDirName(meta.slug) === dirName ? meta : null
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
  if (meta && meta.id === skillId(skill.source, skill.slug)) {
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

/**
 * Install state for a whole page: one `readdir` of the skills directory, then
 * the per-skill check only for slugs that already have a directory (which is
 * where installed vs. name-conflict is decided).
 */
export async function annotateInstallStates<T extends NormalizedSkill>(items: T[]): Promise<T[]> {
  let existing: Set<string>
  try {
    existing = new Set(await fs.readdir(getMarketSkillsDir()))
  } catch {
    existing = new Set()
  }
  return Promise.all(items.map((item) => {
    const dirName = sanitizeDirName(item.slug)
    if (dirName && !existing.has(dirName)) {
      return { ...item, installState: 'installable' as const, notInstallableReason: undefined, installedInfo: undefined }
    }
    return annotateInstallState(item)
  }))
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
  /** Defaults to `catalog`. */
  scope?: MarketScope
  /** Catalog category key; ignored by the `market` scope. */
  category?: string
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
  if (params.scope !== 'market') return listCatalogSkills(params)
  return listLiveMarketSkills(params)
}

async function listLiveMarketSkills(params: MarketListParams): Promise<MarketListResult> {
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
  merged = await annotateInstallStates(merged.map(markCurated))

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

  return { scope: 'market', items: merged, nextCursor: encodeCursor(nextCursor), sources }
}

/**
 * Mark a live result that is a curated catalog skill. ClawHub slugs are shared
 * across owners, so a ClawHub result only counts when its owner is the one the
 * catalog pins (list payloads carry no owner and are never marked).
 */
function markCurated(item: NormalizedSkill): NormalizedSkill {
  const entry = catalogEntryFor(item.source, item.slug)
  if (!entry) return item
  if (item.source === 'clawhub' && item.author.handle !== entry.owner) return item
  return { ...item, curated: true, featured: entry.featured === true ? true : undefined, category: entry.category }
}

// ─── Curated catalog ─────────────────────────────────────────────────────────

const CATALOG_CURSOR_PREFIX = 'catalog:'

/**
 * One page of the curated catalog.
 *
 * Everything is local, so every filter — security and installed included —
 * runs before pagination: a page is always full until the list is exhausted,
 * which keeps infinite scroll from stalling on a filtered-out page.
 */
export async function listCatalogSkills(params: MarketListParams): Promise<MarketListResult> {
  const catalog = getCatalog()
  let items = await annotateInstallStates(
    filterCatalog({ q: params.q, category: params.category, source: params.source }).map(catalogEntryToSkill),
  )
  if (params.security && params.security !== 'all') {
    items = items.filter((item) => item.securityStatus === params.security)
  }
  if (params.installed && params.installed !== 'all') {
    items = items.filter((item) =>
      params.installed === 'installed' ? item.installState === 'installed' : item.installState !== 'installed',
    )
  }
  const raw = params.cursor?.startsWith(CATALOG_CURSOR_PREFIX) ? params.cursor.slice(CATALOG_CURSOR_PREFIX.length) : ''
  const offset = Math.max(0, Number.parseInt(raw, 10) || 0)
  const end = offset + params.limit
  // Provenance of every catalog answer: one snapshot, read when it was generated.
  const status: SourceStatusInfo = { status: 'ok', fetchedAt: catalog.generatedAt, fromCache: true }
  return {
    scope: 'catalog',
    items: items.slice(offset, end),
    nextCursor: end < items.length ? `${CATALOG_CURSOR_PREFIX}${end}` : null,
    sources: { clawhub: status, skillhub: { ...status } },
    total: items.length,
    categories: catalogCategories(),
    catalogGeneratedAt: catalog.generatedAt,
  }
}

/**
 * Overlay the catalog's editorial fields on a live detail.
 *
 * Upstream stays authoritative for everything it owns (version, files,
 * security, stats); the catalog only adds what upstream does not have — the
 * category, the editor's pick, the reader-facing zh-CN summary, fallback tags
 * and the note explaining a flagged verdict the catalog accepted.
 */
export function withCatalogMetadata(detail: NormalizedSkillDetail, requestedOwner?: string): NormalizedSkillDetail {
  const entry = catalogEntryFor(detail.source, detail.slug)
  if (!entry) return detail
  if (detail.source === 'clawhub') {
    // A different owner's copy of a catalog slug is not the curated skill.
    const owner = requestedOwner || detail.author.handle
    if (owner && owner !== entry.owner) return detail
  }
  const summaryEn = detail.summary || entry.summaryEn
  return {
    ...detail,
    category: entry.category,
    featured: entry.featured === true ? true : undefined,
    curated: true,
    summary: entry.summary || detail.summary,
    ...(summaryEn ? { summaryEn } : {}),
    tags: detail.tags.length > 0 ? detail.tags : [...entry.tags],
    ...(detail.securityStatus === 'flagged' && entry.securityNote ? { securityNote: entry.securityNote } : {}),
  }
}

// ─── Detail / file content ───────────────────────────────────────────────────

/**
 * The ClawHub owner a request names (the card it came from). SkillHub slugs
 * are unique, so an owner there means nothing and is dropped.
 */
function requestOwner(source: MarketSource, owner: string | undefined): string | undefined {
  return source === 'clawhub' && owner ? owner : undefined
}

/** Run a whole detail/file/install operation pinned to the requested owner. */
export function withMarketOwner<T>(
  source: MarketSource,
  slug: string,
  owner: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return withClawhubOwner(slug, requestOwner(source, owner), operation)
}

function ownerCacheSuffix(source: MarketSource, owner: string | undefined): string {
  const pinned = requestOwner(source, owner)
  return pinned ? `@${pinned}` : ''
}

export async function getMarketSkillDetail(
  source: MarketSource,
  slug: string,
  options: { owner?: string } = {},
): Promise<{ skill: NormalizedSkillDetail; sourceStatus: SourceStatusInfo }> {
  const owner = requestOwner(source, options.owner)
  const cacheKey = `detail:${source}:${slug}${ownerCacheSuffix(source, owner)}`
  let detail = marketCache.get<NormalizedSkillDetail>(cacheKey)
  let sourceStatus: SourceStatusInfo = { status: 'ok', fetchedAt: Date.now(), fromCache: true }

  if (!detail) {
    try {
      detail = await withMarketOwner(source, slug, owner, () => providers[source].detail(slug))
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

  const annotated = applyFileLimits(await annotateInstallState(withCatalogMetadata(detail, owner)))
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
  owner?: string,
): Promise<MarketFileContent> {
  const cacheKey = `file:${source}:${slug}${ownerCacheSuffix(source, owner)}:${filePath}`
  const cached = marketCache.get<MarketFileContent>(cacheKey)
  if (cached) return cached

  const fetched = await withMarketOwner(source, slug, owner, () => providers[source].fetchFile(slug, filePath))
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
export async function resolveMarketSkill(
  source: MarketSource,
  slug: string,
  owner?: string,
): Promise<NormalizedSkillDetail> {
  const { skill } = await getMarketSkillDetail(source, slug, { owner })
  return skill
}

export function marketSkillId(source: MarketSource, slug: string): string {
  return skillId(source, slug)
}
