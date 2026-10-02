import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resetMarketCacheForTests } from '../services/market/cache.js'
import { getCatalog, type CatalogEntry } from '../services/market/catalog/catalog.js'
import {
  annotateInstallState,
  annotateInstallStates,
  applyFileLimits,
  decodeCursor,
  dedupeSkills,
  encodeCursor,
  listMarketSkills,
  getMarketSkillDetail,
} from '../services/market/marketService.js'
import { MARKET_LIMITS, type NormalizedSkill, type NormalizedSkillDetail } from '../services/market/types.js'

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'market')

let tmpHome: string
let originalClaudeConfigDir: string | undefined
let requested: string[] = []
const originalFetch = globalThis.fetch

function stubFetch(handler: (url: string) => { status?: number; body: string } | undefined) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    requested.push(url)
    const result = handler(url)
    if (!result) return new Response('Not found', { status: 404 })
    return new Response(result.body, {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

async function fixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES, name), 'utf-8')
}

function makeSkill(overrides: Partial<NormalizedSkill> = {}): NormalizedSkill {
  return {
    id: 'clawhub:demo',
    source: 'clawhub',
    slug: 'demo',
    name: 'Demo',
    summary: 'demo skill',
    author: { handle: 'alice' },
    stats: { downloads: 10 },
    tags: [],
    securityStatus: 'unknown',
    installState: 'installable',
    ...overrides,
  }
}

function makeDetail(overrides: Partial<NormalizedSkillDetail> = {}): NormalizedSkillDetail {
  return {
    ...makeSkill(),
    description: '# Demo',
    files: [{ path: 'SKILL.md', size: 100, language: 'markdown', tooBig: false }],
    totalSize: 100,
    ...overrides,
  }
}

beforeEach(async () => {
  requested = []
  resetMarketCacheForTests()
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'market-service-test-'))
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
  delete process.env.HAHA_MARKET_DISABLE_PROVIDERS
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  delete process.env.HAHA_MARKET_DISABLE_PROVIDERS
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('cursor codec', () => {
  it('round-trips a merged cursor', () => {
    const encoded = encodeCursor({ clawhub: 'abc', skillhub: '3' })
    expect(encoded).toBeTruthy()
    expect(decodeCursor(encoded)).toEqual({ clawhub: 'abc', skillhub: '3' })
  })

  it('returns null for an empty cursor and undefined for garbage', () => {
    expect(encodeCursor({})).toBeNull()
    expect(decodeCursor('!!!not-base64!!!')).toBeUndefined()
    expect(decodeCursor(undefined)).toBeUndefined()
  })
})

describe('dedupeSkills', () => {
  it('merges a SkillHub mirror into the ClawHub original', () => {
    const original = makeSkill({ id: 'clawhub:git', slug: 'git', tags: [] })
    const mirror = makeSkill({
      id: 'skillhub:git-mirror',
      source: 'skillhub',
      slug: 'git-mirror',
      upstream: { source: 'clawhub', slug: 'git' },
      iconUrl: 'https://img.example/icon.png',
      securityStatus: 'benign',
      tags: ['工具'],
    })

    const result = dedupeSkills([original, mirror])

    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe('clawhub:git')
    expect(result[0]!.mirrors).toEqual(['skillhub:git-mirror'])
    expect(result[0]!.iconUrl).toBe('https://img.example/icon.png')
    expect(result[0]!.securityStatus).toBe('benign')
    expect(result[0]!.tags).toEqual(['工具'])
  })

  it('keeps the mirror when the original is absent from the page', () => {
    const mirror = makeSkill({
      id: 'skillhub:m',
      source: 'skillhub',
      slug: 'm',
      upstream: { source: 'clawhub', slug: 'not-on-this-page' },
    })

    const result = dedupeSkills([mirror])

    expect(result.length).toBe(1)
    expect(result[0]!.upstream?.slug).toBe('not-on-this-page')
  })
})

describe('annotateInstallState', () => {
  it('marks a skill installed when the market meta matches', async () => {
    const dir = path.join(tmpHome, '.claude', 'skills', 'demo')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, '.market-meta.json'),
      JSON.stringify({ id: 'clawhub:demo', source: 'clawhub', slug: 'demo', version: '1.0.0', installedAt: 'x', fileCount: 1 }),
    )

    const result = await annotateInstallState(makeSkill())

    expect(result.installState).toBe('installed')
    expect(result.installedInfo?.dirName).toBe('demo')
    expect(result.installedInfo?.version).toBe('1.0.0')
  })

  it('flags a name conflict for a manually created directory', async () => {
    await fs.mkdir(path.join(tmpHome, '.claude', 'skills', 'demo'), { recursive: true })

    const result = await annotateInstallState(makeSkill())

    expect(result.installState).toBe('not-installable')
    expect(result.notInstallableReason).toBe('name-conflict')
  })

  it('flags invalid slugs', async () => {
    const result = await annotateInstallState(makeSkill({ slug: '../evil' }))

    expect(result.installState).toBe('not-installable')
    expect(result.notInstallableReason).toBe('invalid-name')
  })

  it('leaves clean skills installable', async () => {
    const result = await annotateInstallState(makeSkill())

    expect(result.installState).toBe('installable')
  })
})

describe('applyFileLimits', () => {
  it('rejects an empty file list', () => {
    const result = applyFileLimits(makeDetail({ files: [], totalSize: 0 }))
    expect(result.installState).toBe('not-installable')
    expect(result.notInstallableReason).toBe('empty-file-list')
  })

  it('rejects a skill without SKILL.md', () => {
    const result = applyFileLimits(
      makeDetail({ files: [{ path: 'main.py', size: 10, language: 'python', tooBig: false }], totalSize: 10 }),
    )
    expect(result.notInstallableReason).toBe('empty-file-list')
  })

  it('rejects oversized files and marks them tooBig', () => {
    const result = applyFileLimits(
      makeDetail({
        files: [
          { path: 'SKILL.md', size: 100, language: 'markdown', tooBig: false },
          { path: 'big.bin', size: MARKET_LIMITS.maxFileSize + 1, language: 'text', tooBig: false },
        ],
        totalSize: MARKET_LIMITS.maxFileSize + 101,
      }),
    )
    expect(result.notInstallableReason).toBe('file-too-large')
    expect(result.files.find((f) => f.path === 'big.bin')?.tooBig).toBe(true)
  })

  it('accepts a normal skill', () => {
    const result = applyFileLimits(makeDetail())
    expect(result.installState).toBe('installable')
  })
})

describe('listMarketSkills', () => {
  it('aggregates both sources, sorts by downloads and reports ok status', async () => {
    const clawhubBody = await fixture('clawhub-list.json')
    const skillhubBody = await fixture('skillhub-list.json')
    stubFetch((url) => {
      if (url.includes('clawhub.ai')) return { body: clawhubBody }
      return { body: skillhubBody }
    })

    const result = await listMarketSkills({ scope: 'market', source: 'all', limit: 3 })

    expect(result.items.length).toBeGreaterThan(3)
    expect(result.sources.clawhub.status).toBe('ok')
    expect(result.sources.skillhub.status).toBe('ok')
    // Sorted by downloads desc
    const downloads = result.items.map((i) => i.stats.downloads)
    expect([...downloads].sort((a, b) => b - a)).toEqual(downloads)
    expect(result.nextCursor).toBeTruthy()
  })

  it('degrades gracefully when one source fails', async () => {
    const clawhubBody = await fixture('clawhub-list.json')
    stubFetch((url) => {
      if (url.includes('clawhub.ai')) return { body: clawhubBody }
      return { status: 500, body: 'oops' }
    })

    const result = await listMarketSkills({ scope: 'market', source: 'all', limit: 3 })

    expect(result.items.length).toBeGreaterThan(0)
    expect(result.sources.clawhub.status).toBe('ok')
    expect(['failed', 'degraded']).toContain(result.sources.skillhub.status)
    expect(result.sources.skillhub.error).toBeTruthy()
  })

  it('serves stale cache with cached status after upstream starts failing', async () => {
    const clawhubBody = await fixture('clawhub-list.json')
    const skillhubBody = await fixture('skillhub-list.json')
    stubFetch((url) => {
      if (url.includes('clawhub.ai')) return { body: clawhubBody }
      return { body: skillhubBody }
    })
    await listMarketSkills({ scope: 'market', source: 'all', limit: 3 })

    // Now both upstreams fail — but entries are cached (fresh) so still ok/fromCache.
    stubFetch(() => ({ status: 500, body: 'down' }))
    const result = await listMarketSkills({ scope: 'market', source: 'all', limit: 3 })

    expect(result.items.length).toBeGreaterThan(0)
    expect(result.sources.clawhub.fromCache).toBe(true)
  })

  it('respects the source filter', async () => {
    const clawhubBody = await fixture('clawhub-list.json')
    stubFetch((url) => {
      if (url.includes('clawhub.ai')) return { body: clawhubBody }
      return { status: 500, body: 'should not be called' }
    })

    const result = await listMarketSkills({ scope: 'market', source: 'clawhub', limit: 3 })

    expect(result.items.every((i) => i.source === 'clawhub')).toBe(true)
    expect(requested.every((u) => u.includes('clawhub.ai'))).toBe(true)
  })

  it('filters by installed state', async () => {
    const clawhubBody = await fixture('clawhub-list.json')
    stubFetch((url) => (url.includes('clawhub.ai') ? { body: clawhubBody } : { status: 500, body: 'x' }))

    // Install one of the fixture skills manually with market meta
    const items = JSON.parse(clawhubBody).items as Array<{ slug: string }>
    const slug = items[0]!.slug
    const dir = path.join(tmpHome, '.claude', 'skills', slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, '.market-meta.json'),
      JSON.stringify({ id: `clawhub:${slug}`, source: 'clawhub', slug, installedAt: 'x', fileCount: 1 }),
    )

    const installed = await listMarketSkills({ scope: 'market', source: 'clawhub', limit: 3, installed: 'installed' })
    expect(installed.items.length).toBe(1)
    expect(installed.items[0]!.slug).toBe(slug)

    resetMarketCacheForTests()
    const notInstalled = await listMarketSkills({ scope: 'market', source: 'clawhub', limit: 3, installed: 'installable' })
    expect(notInstalled.items.every((i) => i.slug !== slug)).toBe(true)
  })

  it('filters by security status', async () => {
    const envelope = {
      code: 0,
      data: { skills: [{ slug: 'a', name: 'A', verified: true }, { slug: 'b', name: 'B' }], total: 2 },
    }
    stubFetch((url) => (url.includes('skillhub') ? { body: JSON.stringify(envelope) } : { body: '{"items":[]}' }))

    const result = await listMarketSkills({ scope: 'market', source: 'skillhub', limit: 24, security: 'verified' })

    expect(result.items.length).toBe(1)
    expect(result.items[0]!.slug).toBe('a')
  })
})

describe('getMarketSkillDetail', () => {
  it('caches the detail so a second call issues no upstream requests', async () => {
    const detailBody = await fixture('clawhub-detail.json')
    const versionBody = await fixture('clawhub-version-detail.json')
    stubFetch((url) => (url.includes('/versions/') ? { body: versionBody } : { body: detailBody }))

    await getMarketSkillDetail('clawhub', 'git')
    const countAfterFirst = requested.length
    const second = await getMarketSkillDetail('clawhub', 'git')

    expect(requested.length).toBe(countAfterFirst)
    expect(second.sourceStatus.fromCache).toBe(true)
    expect(second.skill.files.length).toBeGreaterThan(0)
  })
})

// ─── Curated catalog scope ───────────────────────────────────────────────────

const catalog = getCatalog()

function catalogEntry(predicate: (entry: CatalogEntry) => boolean): CatalogEntry {
  const entry = catalog.skills.find(predicate)
  if (!entry) throw new Error('fixture assumption: no matching catalog entry')
  return entry
}

async function writeMeta(slug: string, source: 'clawhub' | 'skillhub') {
  const dir = path.join(tmpHome, '.claude', 'skills', slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, '.market-meta.json'),
    JSON.stringify({ id: `${source}:${slug}`, source, slug, version: '9.9.9', installedAt: 'x', fileCount: 1 }),
  )
}

function failOnAnyFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    requested.push(url)
    throw new Error(`catalog scope must not fetch ${url}`)
  }) as typeof fetch
}

describe('listMarketSkills (catalog scope)', () => {
  it('is the default scope and pages through the whole snapshot without any upstream request', async () => {
    failOnAnyFetch()

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await listMarketSkills({ source: 'all', limit: 24, cursor })
      expect(page.scope).toBe('catalog')
      expect(page.total).toBe(catalog.skills.length)
      expect(page.catalogGeneratedAt).toBe(catalog.generatedAt)
      expect(page.sources.clawhub).toEqual({ status: 'ok', fetchedAt: catalog.generatedAt, fromCache: true })
      expect(page.sources.skillhub.fetchedAt).toBe(catalog.generatedAt)
      if (page.nextCursor) {
        expect(page.items.length).toBe(24)
        expect(page.nextCursor).toBe(`catalog:${seen.length + 24}`)
      }
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor && pages < 100)

    expect(seen).toEqual(catalog.skills.map((entry) => `${entry.source}:${entry.slug}`))
    expect(requested).toEqual([])
  })

  it('returns static category counts and curated card fields', async () => {
    failOnAnyFetch()
    const flagged = catalogEntry((entry) => entry.security === 'flagged')

    const result = await listMarketSkills({ source: 'all', limit: 500 })

    expect(result.categories!.map((category) => category.key)).toEqual(catalog.categories.map((category) => category.key))
    expect(result.categories!.reduce((sum, category) => sum + category.count, 0)).toBe(catalog.skills.length)
    const card = result.items.find((item) => item.slug === flagged.slug)!
    expect(card.curated).toBe(true)
    expect(card.category).toBe(flagged.category)
    expect(card.summary).toBe(flagged.summary)
    expect(card.summaryEn).toBe(flagged.summaryEn)
    expect(card.securityStatus).toBe('flagged')
    expect(card.securityNote).toBe(flagged.securityNote)
    expect(result.items.filter((item) => item.featured).length).toBe(catalog.skills.filter((entry) => entry.featured).length)
  })

  it('filters by security before paginating so every page is full', async () => {
    failOnAnyFetch()
    const benignCount = catalog.skills.filter((entry) => entry.security === 'benign').length

    const first = await listMarketSkills({ source: 'all', limit: 24, security: 'benign' })
    const second = await listMarketSkills({ source: 'all', limit: 24, security: 'benign', cursor: first.nextCursor! })

    expect(first.total).toBe(benignCount)
    expect(first.items.length).toBe(24)
    expect(second.items.length).toBe(24)
    expect([...first.items, ...second.items].every((item) => item.securityStatus === 'benign')).toBe(true)
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(48)

    const flagged = await listMarketSkills({ source: 'all', limit: 3, security: 'flagged' })
    expect(flagged.items.length).toBe(3)
    expect(flagged.total).toBe(catalog.skills.filter((entry) => entry.security === 'flagged').length)
  })

  it('annotates install state from the skills directory and filters by it before paginating', async () => {
    failOnAnyFetch()
    const [a, b, c] = catalog.skills.slice(-3) as [CatalogEntry, CatalogEntry, CatalogEntry]
    await writeMeta(a.slug, a.source)
    await writeMeta(b.slug, b.source)
    // A hand-made directory with the same name is a conflict, not an install.
    await fs.mkdir(path.join(tmpHome, '.claude', 'skills', c.slug), { recursive: true })

    const installed = await listMarketSkills({ source: 'all', limit: 24, installed: 'installed' })
    expect(installed.items.map((item) => item.slug).sort()).toEqual([a.slug, b.slug].sort())
    expect(installed.total).toBe(2)
    expect(installed.items[0]!.installedInfo?.version).toBe('9.9.9')

    const installable = await listMarketSkills({ source: 'all', limit: 500, installed: 'installable' })
    expect(installable.total).toBe(catalog.skills.length - 2)
    const conflict = installable.items.find((item) => item.slug === c.slug)!
    expect(conflict.installState).toBe('not-installable')
    expect(conflict.notInstallableReason).toBe('name-conflict')
  })

  it('filters by category and source; an unknown category is an empty page', async () => {
    failOnAnyFetch()
    const category = catalog.categories[2]!.key

    const inCategory = await listMarketSkills({ source: 'all', limit: 500, category })
    expect(inCategory.items.length).toBeGreaterThan(0)
    expect(inCategory.items.every((item) => item.category === category)).toBe(true)
    expect(inCategory.total).toBe(inCategory.categories!.find((entry) => entry.key === category)!.count)

    const skillhubOnly = await listMarketSkills({ source: 'skillhub', limit: 500 })
    expect(skillhubOnly.total).toBe(catalog.skills.filter((entry) => entry.source === 'skillhub').length)
    expect(skillhubOnly.items.every((item) => item.source === 'skillhub')).toBe(true)

    const unknown = await listMarketSkills({ source: 'all', limit: 24, category: 'no-such-category' })
    expect(unknown.items).toEqual([])
    expect(unknown.total).toBe(0)
    expect(unknown.nextCursor).toBeNull()
    expect(unknown.categories!.length).toBe(catalog.categories.length)
  })
})

describe('annotateInstallStates', () => {
  it('matches the per-skill annotation for installed, conflicting, invalid and clean skills', async () => {
    await writeMeta('demo', 'clawhub')
    await fs.mkdir(path.join(tmpHome, '.claude', 'skills', 'taken'), { recursive: true })
    const skills = [
      makeSkill(),
      makeSkill({ id: 'clawhub:taken', slug: 'taken' }),
      makeSkill({ id: 'clawhub:../x', slug: '../x' }),
      makeSkill({ id: 'clawhub:fresh', slug: 'fresh' }),
    ]

    const batched = await annotateInstallStates(skills)
    const single = await Promise.all(skills.map((skill) => annotateInstallState(skill)))

    expect(batched).toEqual(single)
    expect(batched.map((skill) => skill.installState)).toEqual(['installed', 'not-installable', 'not-installable', 'installable'])
  })

  it('treats a missing skills directory as nothing installed', async () => {
    const [result] = await annotateInstallStates([makeSkill()])
    expect(result!.installState).toBe('installable')
  })
})

describe('listMarketSkills (market scope) curated marking', () => {
  it('marks catalog matches, requiring the pinned owner for ClawHub results', async () => {
    const skillhubPick = catalogEntry((entry) => entry.source === 'skillhub' && entry.featured === true)
    const clawhubEntry = catalogEntry((entry) => entry.source === 'clawhub' && entry.featured === true)
    const otherClawhub = catalogEntry((entry) => entry.source === 'clawhub' && entry.slug !== clawhubEntry.slug)
    stubFetch((url) => {
      if (url.includes('clawhub.ai')) {
        return { body: JSON.stringify({ results: [
          { slug: clawhubEntry.slug, downloads: 30, ownerHandle: clawhubEntry.owner },
          { slug: otherClawhub.slug, downloads: 20, ownerHandle: `${otherClawhub.owner}-copycat` },
        ] }) }
      }
      return { body: JSON.stringify({ code: 0, data: { skills: [
        { slug: skillhubPick.slug, name: 'pick', downloads: 10, category: 'raw-upstream-category' },
        { slug: 'not-in-catalog-xyz', name: 'other', downloads: 5, category: 'raw-upstream-category' },
      ], total: 2 } }) }
    })

    const result = await listMarketSkills({ scope: 'market', source: 'all', q: 'anything', limit: 24 })

    expect(result.scope).toBe('market')
    expect(result.total).toBeUndefined()
    const byId = new Map(result.items.map((item) => [item.id, item]))
    const curatedClawhub = byId.get(`clawhub:${clawhubEntry.slug}`)!
    expect(curatedClawhub.curated).toBe(true)
    expect(curatedClawhub.featured).toBe(true)
    expect(curatedClawhub.category).toBe(clawhubEntry.category)
    expect(byId.get(`clawhub:${otherClawhub.slug}`)!.curated).toBeUndefined()
    const pick = byId.get(`skillhub:${skillhubPick.slug}`)!
    expect(pick.curated).toBe(true)
    expect(pick.featured).toBe(true)
    expect(pick.category).toBe(skillhubPick.category)
    const other = byId.get('skillhub:not-in-catalog-xyz')!
    expect(other.curated).toBeUndefined()
    expect(other.category).toBe('raw-upstream-category')
  })
})

describe('getMarketSkillDetail catalog overlay', () => {
  async function stubClawhubDetail(mutate: (detail: any, version: any) => void = () => {}) {
    const detail = JSON.parse(await fixture('clawhub-detail.json'))
    const version = JSON.parse(await fixture('clawhub-version-detail.json'))
    mutate(detail, version)
    stubFetch((url) => (url.includes('/versions/') ? { body: JSON.stringify(version) } : { body: JSON.stringify(detail) }))
    return detail
  }

  const fixtureSlug = 'g' + 'it'

  it('overlays editorial fields on a curated ClawHub detail and pins its owner', async () => {
    const entry = catalogEntry((candidate) => candidate.source === 'clawhub' && candidate.slug === fixtureSlug)
    const raw = await stubClawhubDetail()

    const { skill } = await getMarketSkillDetail('clawhub', fixtureSlug)

    expect(requested.length).toBeGreaterThan(0)
    expect(requested.every((url) => new URL(url).searchParams.get('owner') === entry.owner)).toBe(true)
    expect(skill.curated).toBe(true)
    expect(skill.category).toBe(entry.category)
    expect(skill.summary).toBe(entry.summary)
    expect(skill.summaryEn).toBe(raw.skill.summary)
    // Upstream topics win; upstream stays authoritative for version and files.
    expect(skill.tags).toEqual(raw.skill.topics)
    expect(skill.version).toBe('1.0.8')
    expect(skill.files.length).toBeGreaterThan(0)
    expect(skill.securityNote).toBeUndefined()
    expect(skill.changelog?.text).toContain('Simplified')
  })

  it('fills empty upstream tags from the catalog and explains a still-flagged verdict', async () => {
    const entry = catalogEntry((candidate) => candidate.source === 'clawhub' && candidate.security === 'flagged')
    await stubClawhubDetail((detail, version) => {
      detail.skill.slug = entry.slug
      detail.skill.topics = []
      detail.owner.handle = entry.owner
      version.version.security.status = 'suspicious'
    })

    const { skill } = await getMarketSkillDetail('clawhub', entry.slug)

    expect(skill.securityStatus).toBe('flagged')
    expect(skill.securityNote).toBe(entry.securityNote)
    expect(skill.tags).toEqual(entry.tags)
  })

  it('drops the security note once upstream clears the skill', async () => {
    const entry = catalogEntry((candidate) => candidate.source === 'clawhub' && candidate.security === 'flagged')
    await stubClawhubDetail((detail) => {
      detail.skill.slug = entry.slug
      detail.owner.handle = entry.owner
    })

    const { skill } = await getMarketSkillDetail('clawhub', entry.slug)

    expect(skill.securityStatus).toBe('benign')
    expect(skill.curated).toBe(true)
    expect(skill.securityNote).toBeUndefined()
  })

  it('does not overlay a ClawHub detail served for a different owner', async () => {
    await stubClawhubDetail((detail) => {
      detail.owner.handle = 'someone-else'
    })

    const { skill } = await getMarketSkillDetail('clawhub', fixtureSlug)

    expect(skill.curated).toBeUndefined()
    expect(skill.summary).toStartWith('Git commits')
  })

  it('a requested owner wins over the catalog hint, even when upstream omits the owner', async () => {
    await stubClawhubDetail((detail) => {
      detail.owner = null
    })

    const { skill } = await getMarketSkillDetail('clawhub', fixtureSlug, { owner: 'other' })

    expect(requested.length).toBeGreaterThan(0)
    expect(requested.every((url) => new URL(url).searchParams.get('owner') === 'other')).toBe(true)
    expect(skill.curated).toBeUndefined()
    expect(skill.summary).toStartWith('Git commits')
  })

  it('ignores an owner for SkillHub details', async () => {
    const detailBody = await fixture('skillhub-detail.json')
    stubFetch((url) => (url.includes('/files') ? { body: '{"count":0,"files":[]}' } : { body: detailBody }))

    await getMarketSkillDetail('skillhub', 'pe-compliance-expert-pro', { owner: 'someone' })

    expect(requested.some((url) => new URL(url).searchParams.has('owner'))).toBe(false)
  })

  it('leaves skills outside the catalog untouched', async () => {
    await stubClawhubDetail((detail) => {
      detail.skill.slug = 'not-in-catalog-xyz'
    })

    const { skill } = await getMarketSkillDetail('clawhub', 'not-in-catalog-xyz')

    expect(skill.curated).toBeUndefined()
    expect(skill.category).toBeUndefined()
    expect(skill.summaryEn).toBeUndefined()
  })
})
