/**
 * Skills Market — curated catalog, the market's home list.
 *
 * The upstream registries hold ~80k ClawHub and ~110k SkillHub skills; nobody
 * chooses from that. The home list is instead a few hundred reviewed skills,
 * shipped with the app as `skills.json` so the home page needs no network.
 *
 * Maintenance:
 *  - `curation.json` is the editorial source (which skills, which category, the
 *    zh-CN summary and tags, editor's picks). It is ported from dsh-skills-hub
 *    and synced by hand; it is never imported at runtime.
 *  - `bun run scripts/market-catalog-refresh.ts` re-reads what upstream owns
 *    (name, stats, version, icon, security verdict) and rewrites `skills.json`;
 *    `--check` only reports. It hits the live registries, so no test or CI lane
 *    runs it. A refresh never changes the selection.
 *  - Selection/security policy (see `catalogSnapshot.ts`): an entry upstream no
 *    longer serves, whose owner changed, or that upstream calls malicious is
 *    dropped; a suspicious verdict ships (as `flagged`, with a `securityNote`)
 *    only when the curation entry carries an `allowSuspicious` reason.
 *
 * Only the list comes from the snapshot. Detail, file preview and install still
 * read the owning registry, so nobody installs the snapshot's version of a skill.
 */

import data from './skills.json'
import {
  skillId,
  type MarketCategory,
  type MarketSource,
  type NormalizedSkill,
  type SecurityStatus,
} from '../types.js'

export type CatalogEntry = {
  source: MarketSource
  slug: string
  /** Registry owner; disambiguates ClawHub slugs shared by several authors. */
  owner: string
  name: string
  /** Reader-facing summary (zh-CN). */
  summary: string
  /** Original upstream summary, kept for English readers and search. */
  summaryEn?: string
  /** Key into `categories`. */
  category: string
  tags: string[]
  /** Editor's pick: listed first and marked on the card. */
  featured?: boolean
  stats: { downloads: number; installs?: number; stars?: number }
  version?: string
  updatedAt?: number
  iconUrl?: string
  security: SecurityStatus
  /** Why the security verdict is what it is, when it is not clean. */
  securityNote?: string
  requiresApiKey?: boolean
  license?: string
}

export type CatalogCategoryDef = { key: string; name: string; nameEn: string }

export type CatalogFile = {
  version: 1
  /** Epoch millis of the upstream reads behind this snapshot. */
  generatedAt: number
  categories: CatalogCategoryDef[]
  skills: CatalogEntry[]
}

const catalog = data as CatalogFile

export function getCatalog(): CatalogFile {
  return catalog
}

const bySkillId = new Map(catalog.skills.map((entry) => [skillId(entry.source, entry.slug), entry]))

export function catalogEntryFor(source: MarketSource, slug: string): CatalogEntry | undefined {
  return bySkillId.get(skillId(source, slug))
}

/** Category bar entries in editorial order, counted over the whole catalog. */
export function catalogCategories(): MarketCategory[] {
  const counts = new Map<string, number>()
  for (const entry of catalog.skills) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
  return catalog.categories
    .map((category) => ({ key: category.key, name: category.name, nameEn: category.nameEn, count: counts.get(category.key) ?? 0 }))
    .filter((category) => category.count > 0)
}

/** ClawHub owners the catalog pins, for the provider's slug disambiguation. */
export function catalogClawhubOwners(): Array<readonly [string, string]> {
  return catalog.skills
    .filter((entry) => entry.source === 'clawhub')
    .map((entry) => [entry.slug, entry.owner] as const)
}

export function catalogEntryToSkill(entry: CatalogEntry): NormalizedSkill {
  return {
    id: skillId(entry.source, entry.slug),
    source: entry.source,
    slug: entry.slug,
    name: entry.name,
    summary: entry.summary,
    summaryEn: entry.summaryEn,
    author: { handle: entry.owner },
    stats: { ...entry.stats },
    tags: [...entry.tags],
    category: entry.category,
    version: entry.version,
    updatedAt: entry.updatedAt,
    iconUrl: entry.iconUrl,
    securityStatus: entry.security,
    securityNote: entry.securityNote,
    requiresApiKey: entry.requiresApiKey,
    featured: entry.featured === true ? true : undefined,
    curated: true,
    installState: 'installable',
  }
}

/** Fold case and width so `GitHub`, `github` and full-width input all match. */
function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/**
 * Entries matching every whitespace-separated term, in catalog order.
 *
 * A name/slug hit ranks above a summary, tag or owner hit: typing a skill's
 * name should put that skill first, not the one that mentions it most.
 */
export function filterCatalog(params: { q?: string; category?: string; source?: 'all' | MarketSource }): CatalogEntry[] {
  const terms = fold(params.q ?? '').split(/\s+/).filter(Boolean)
  const strong: CatalogEntry[] = []
  const weak: CatalogEntry[] = []
  for (const entry of catalog.skills) {
    if (params.category && entry.category !== params.category) continue
    if (params.source && params.source !== 'all' && entry.source !== params.source) continue
    if (terms.length === 0) {
      strong.push(entry)
      continue
    }
    const head = fold(`${entry.name} ${entry.slug}`)
    const body = fold(`${entry.summary} ${entry.summaryEn ?? ''} ${entry.tags.join(' ')} ${entry.owner}`)
    if (!terms.every((term) => head.includes(term) || body.includes(term))) continue
    if (terms.every((term) => head.includes(term))) strong.push(entry)
    else weak.push(entry)
  }
  return [...strong, ...weak]
}
