/**
 * Skills Market — pure catalog snapshot builder.
 *
 * `scripts/market-catalog-refresh.ts` fetches the upstream reads; everything
 * that decides what ships (drops, security mapping, home-list order) lives here
 * so it is testable without the network.
 */

import { skillId, type MarketSource, type SecurityStatus } from '../types.js'
import type { CatalogCategoryDef, CatalogEntry, CatalogFile } from './catalog.js'

export type CurationEntry = {
  source: MarketSource
  slug: string
  owner: string
  category: string
  /** Reader-facing summary (zh-CN). */
  summary: string
  tags?: string[]
  featured?: boolean
  /** Reason a `suspicious` upstream verdict is accepted; without it the entry is dropped. */
  allowSuspicious?: string
  iconUrl?: string
}

export type CurationFile = {
  _source?: string
  categories: CatalogCategoryDef[]
  skills: CurationEntry[]
}

export type UpstreamVerdict = 'malicious' | 'suspicious' | 'clean' | 'verified' | 'unknown'

export type VerdictResult = { verdict: UpstreamVerdict; reasons: string[] }

/** What one upstream read contributes to a snapshot entry. */
export type LiveRead = {
  name: string
  summaryEn?: string
  stats: { downloads: number; installs?: number; stars?: number }
  version?: string
  updatedAt?: number
  license?: string
  iconUrl?: string
  requiresApiKey?: boolean
  verdict: UpstreamVerdict
  reasons: string[]
}

/** The entry cannot ship: upstream no longer serves it as curated. */
export type MissingRead = { missing: string }

export type CatalogRead = LiveRead | MissingRead

type Json = Record<string, any> | undefined | null

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** ClawHub: moderation on the skill detail plus the latest version's scan. */
export function clawhubVerdict(detail: Json, versionDetail: Json): VerdictResult {
  const scan = versionDetail?.version?.security ?? {}
  const moderation = detail?.moderation ?? {}
  let verdict: UpstreamVerdict = 'unknown'
  const reasons: string[] = []
  if (moderation.isMalwareBlocked || moderation.verdict === 'malicious' || scan.status === 'malicious') verdict = 'malicious'
  else if (moderation.isSuspicious || scan.status === 'suspicious') verdict = 'suspicious'
  else if (moderation.verdict === 'clean' || scan.status === 'clean') verdict = 'clean'
  if (scan.scanners?.skillspector?.recommendation) reasons.push(`skillspector: ${scan.scanners.skillspector.recommendation}`)
  if (scan.scanners?.llm?.normalizedStatus && scan.scanners.llm.normalizedStatus !== 'clean') reasons.push(`llm review: ${scan.scanners.llm.normalizedStatus}`)
  if (scan.scanners?.vt?.normalizedStatus && scan.scanners.vt.normalizedStatus !== 'clean') reasons.push(`VirusTotal: ${scan.scanners.vt.normalizedStatus}`)
  return { verdict, reasons }
}

/** SkillHub: `queued`/`pending` scans have no verdict yet and leave the skill unknown. */
export function skillhubVerdict(detail: Json): VerdictResult {
  const reports = Object.values((detail?.securityReports ?? {}) as Record<string, any>)
    .map((report) => String(report?.status ?? '').toLowerCase())
    .filter((status) => status !== '' && status !== 'queued' && status !== 'pending')
  let verdict: UpstreamVerdict = 'unknown'
  if (reports.some((status) => status === 'malicious')) verdict = 'malicious'
  else if (reports.some((status) => !['benign', 'safe', 'clean'].includes(status))) verdict = 'suspicious'
  else if (reports.length > 0) verdict = detail?.skill?.verified ? 'verified' : 'clean'
  return { verdict, reasons: reports.length ? [`reports: ${reports.join(', ')}`] : [] }
}

/**
 * ClawHub read from an owner-qualified detail and its latest version.
 * `detail` may be an error marker (`{_status}`/`{_error}`) from the fetcher.
 */
export function readClawhubEntry(entry: CurationEntry, detail: Json, versionDetail: Json): CatalogRead {
  const skill = detail?.skill
  if (!skill) return { missing: `clawhub detail ${detail?._status ?? detail?._error ?? 'empty'}` }
  if (detail?.owner?.handle && detail.owner.handle !== entry.owner) {
    return { missing: `owner is now ${detail.owner.handle}` }
  }
  return {
    name: str(skill.displayName) ?? entry.slug,
    summaryEn: str(skill.summary),
    stats: { downloads: num(skill.stats?.downloads) ?? 0, installs: num(skill.stats?.installs), stars: num(skill.stats?.stars) },
    version: clawhubLatestVersion(detail),
    updatedAt: num(skill.updatedAt),
    license: str(detail?.latestVersion?.license) ?? str(versionDetail?.version?.license),
    ...clawhubVerdict(detail, versionDetail),
  }
}

/** The version a ClawHub detail points at (its version detail carries the scan). */
export function clawhubLatestVersion(detail: Json): string | undefined {
  return str(detail?.latestVersion?.version) ?? str(detail?.skill?.tags?.latest)
}

/** SkillHub read: the slug must still resolve to the curated owner's skill. */
export function readSkillhubEntry(entry: CurationEntry, detail: Json): CatalogRead {
  const skill = detail?.skill
  if (!skill) return { missing: `skillhub detail ${detail?._status ?? detail?._error ?? 'empty'}` }
  const owner = str(detail?.owner?.handle) ?? str(skill.ownerName)
  if (owner && owner !== entry.owner) return { missing: `slug now resolves to ${owner}` }
  return {
    name: str(skill.displayName) ?? str(skill.name) ?? entry.slug,
    summaryEn: str(skill.summary),
    stats: {
      downloads: num(skill.stats?.downloads) ?? 0,
      installs: num(skill.stats?.installs),
      stars: num(skill.stats?.stars),
    },
    version: str(detail?.latestVersion?.version),
    updatedAt: num(skill.updatedAt),
    iconUrl: str(skill.iconUrl),
    requiresApiKey: skill.labels?.requires_api_key === 'true' ? true : undefined,
    ...skillhubVerdict(detail),
  }
}

/** Curation entries worth reading upstream: first occurrence of each id, known category. */
export function curationEntriesToRead(curation: CurationFile): CurationEntry[] {
  const categoryKeys = new Set(curation.categories.map((category) => category.key))
  const seen = new Set<string>()
  return curation.skills.filter((entry) => {
    const id = skillId(entry.source, entry.slug)
    if (seen.has(id) || !categoryKeys.has(entry.category)) return false
    seen.add(id)
    return true
  })
}

function securityFor(verdict: UpstreamVerdict): SecurityStatus {
  if (verdict === 'suspicious') return 'flagged'
  if (verdict === 'verified') return 'verified'
  if (verdict === 'clean') return 'benign'
  return 'unknown'
}

/**
 * Build the shipped snapshot from the editorial source and the upstream reads
 * (keyed by `source:slug`). Drops are reported, never shipped as dead cards.
 */
export function buildCatalogSnapshot(
  curation: CurationFile,
  reads: ReadonlyMap<string, CatalogRead>,
  now: number,
): { snapshot: CatalogFile; problems: string[] } {
  const categoryKeys = new Set(curation.categories.map((category) => category.key))
  const problems: string[] = []
  const seen = new Set<string>()
  const skills: CatalogEntry[] = []

  for (const entry of curation.skills) {
    const id = skillId(entry.source, entry.slug)
    if (seen.has(id)) {
      problems.push(`${id}: duplicate entry`)
      continue
    }
    seen.add(id)
    if (!categoryKeys.has(entry.category)) {
      problems.push(`${id}: unknown category ${entry.category}`)
      continue
    }
    const live = reads.get(id) ?? { missing: 'not read' }
    if ('missing' in live) {
      problems.push(`${id}: ${live.missing}`)
      continue
    }
    if (live.verdict === 'malicious') {
      problems.push(`${id}: upstream verdict: malicious`)
      continue
    }
    if (live.verdict === 'suspicious' && !entry.allowSuspicious) {
      problems.push(`${id}: suspicious (${live.reasons.join('; ')})`)
      continue
    }
    const security = securityFor(live.verdict)
    // Key order is the file's order; JSON round trip drops undefined fields.
    const skill = {
      source: entry.source,
      slug: entry.slug,
      owner: entry.owner,
      name: live.name,
      summary: entry.summary,
      summaryEn: live.summaryEn,
      category: entry.category,
      tags: entry.tags ?? [],
      featured: entry.featured === true ? true : undefined,
      stats: live.stats,
      version: live.version,
      updatedAt: live.updatedAt,
      iconUrl: live.iconUrl ?? entry.iconUrl,
      security,
      securityNote: security === 'flagged' ? [entry.allowSuspicious, ...live.reasons].filter(Boolean).join('; ') : undefined,
      requiresApiKey: live.requiresApiKey,
      license: live.license,
    }
    skills.push(JSON.parse(JSON.stringify(skill)) as CatalogEntry)
  }

  return {
    snapshot: { version: 1, generatedAt: now, categories: curation.categories, skills: orderForHome(curation.categories, skills) },
    problems,
  }
}

/**
 * Home-list order. Download counts are not comparable across registries
 * (SkillHub's run far higher with near-zero installs), so popularity is the
 * percentile within each source. Editor's picks lead, dealt round-robin across
 * categories so the first screen shows the breadth of the catalog.
 */
export function orderForHome(categories: CatalogCategoryDef[], skills: CatalogEntry[]): CatalogEntry[] {
  const percentile = new Map<CatalogEntry, number>()
  for (const source of ['clawhub', 'skillhub'] as const) {
    const ranked = skills.filter((skill) => skill.source === source).sort((a, b) => b.stats.downloads - a.stats.downloads)
    ranked.forEach((skill, index) => percentile.set(skill, 1 - index / Math.max(1, ranked.length)))
  }
  const byPopularity = (a: CatalogEntry, b: CatalogEntry) => percentile.get(b)! - percentile.get(a)!
  const picks = new Map<string, CatalogEntry[]>(categories.map((category) => [category.key, []]))
  const featured = skills.filter((entry) => entry.featured).sort(byPopularity)
  for (const skill of featured) picks.get(skill.category)?.push(skill)
  const lead: CatalogEntry[] = []
  const rounds = Math.max(0, ...[...picks.values()].map((queue) => queue.length))
  for (let round = 0; round < rounds; round++) {
    for (const queue of picks.values()) if (queue[round]) lead.push(queue[round]!)
  }
  const rest = skills.filter((entry) => !entry.featured).sort(byPopularity)
  return [...lead, ...rest]
}
