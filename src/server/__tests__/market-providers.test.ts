import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  clawhubOwnerFor,
  clawhubProvider,
  getClawhubOwnerHints,
  resetClawhubOwnerCacheForTests,
  setClawhubOwnerHints,
  withClawhubOwner,
} from '../services/market/clawhubProvider.js'
import { skillhubProvider } from '../services/market/skillhubProvider.js'
import { resetMarketCacheForTests } from '../services/market/cache.js'
import { MarketUpstreamError, meaningfulChangelog } from '../services/market/types.js'

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'market')

async function fixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES, name), 'utf-8')
}

type FetchStub = (url: string) => { status?: number; body: string; contentType?: string } | undefined

let requestedUrls: string[] = []
let originalDisableProvidersEnv: string | undefined
let originalOwnerHints: Array<[string, string]> = []
const originalFetch = globalThis.fetch

function stubFetch(handler: FetchStub) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    requestedUrls.push(url)
    const result = handler(url)
    if (!result) return new Response('Not found', { status: 404 })
    return new Response(result.body, {
      status: result.status ?? 200,
      headers: { 'Content-Type': result.contentType ?? 'application/json' },
    })
  }) as typeof fetch
}

beforeEach(() => {
  requestedUrls = []
  resetMarketCacheForTests()
  resetClawhubOwnerCacheForTests()
  // Importing marketService elsewhere in the same run injects catalog hints;
  // provider tests start unpinned and restore whatever was there.
  originalOwnerHints = getClawhubOwnerHints()
  setClawhubOwnerHints([])
  originalDisableProvidersEnv = process.env.HAHA_MARKET_DISABLE_PROVIDERS
  delete process.env.HAHA_MARKET_DISABLE_PROVIDERS
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setClawhubOwnerHints(originalOwnerHints)
  // Restore rather than delete: these are the developer's variables, not ours.
  if (originalDisableProvidersEnv === undefined) {
    delete process.env.HAHA_MARKET_DISABLE_PROVIDERS
  } else {
    process.env.HAHA_MARKET_DISABLE_PROVIDERS = originalDisableProvidersEnv
  }
})

describe('clawhubProvider', () => {
  it('normalizes list items and passes through cursor pagination', async () => {
    const body = await fixture('clawhub-list.json')
    stubFetch(() => ({ body }))

    const page = await clawhubProvider.list({ limit: 3 })

    expect(requestedUrls[0]).toContain('clawhub.ai/api/v1/skills')
    expect(requestedUrls[0]).toContain('limit=3')
    expect(page.items.length).toBeGreaterThan(0)
    const first = page.items[0]!
    expect(first.id).toBe(`clawhub:${first.slug}`)
    expect(first.source).toBe('clawhub')
    expect(first.name.length).toBeGreaterThan(0)
    expect(typeof first.stats.downloads).toBe('number')
    expect(first.securityStatus).toBe('unknown')
    expect(page.nextCursor).toBeDefined()
  })

  it('forwards the cursor on subsequent pages', async () => {
    const body = await fixture('clawhub-list.json')
    stubFetch(() => ({ body }))

    await clawhubProvider.list({ limit: 3, cursor: 'abc123' })

    expect(requestedUrls[0]).toContain('cursor=abc123')
  })

  it('returns empty items for an empty search', async () => {
    stubFetch(() => ({ body: '{"results":[]}' }))

    const page = await clawhubProvider.search({ q: 'zzz-nothing', limit: 24 })

    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeUndefined()
  })

  it('normalizes search results with owner info', async () => {
    const body = await fixture('clawhub-search.json')
    stubFetch(() => ({ body }))

    const page = await clawhubProvider.search({ q: 'git', limit: 24 })

    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items[0]!.author.handle.length).toBeGreaterThan(0)
  })

  it('filters aggregated external search results before applying the limit', async () => {
    stubFetch(() => ({ body: JSON.stringify({ results: [
      { slug: 'typesafe-ai', source: 'skills-sh', install: { kind: 'skills-sh' } },
      { slug: 'external', source: 'other-registry' },
      { slug: 'external-install', install: { kind: 'skills-sh' } },
      { slug: 'oo-typesafe-ai', source: 'clawhub', install: { kind: 'clawhub' } },
      { slug: 'legacy-native' },
    ] }) }))

    const page = await clawhubProvider.search({ q: 'typesafe', limit: 2 })

    expect(page.items.map((item) => item.id)).toEqual([
      'clawhub:oo-typesafe-ai',
      'clawhub:legacy-native',
    ])
    expect(page.nextCursor).toBeUndefined()
  })

  it('returns no installable entries when search only contains external sources', async () => {
    stubFetch(() => ({ body: JSON.stringify({ results: [
      { slug: 'typesafe-ai', source: 'skills-sh', install: { kind: 'skills-sh' } },
    ] }) }))

    const page = await clawhubProvider.search({ q: 'typesafe', limit: 24 })

    expect(page.items).toEqual([])
  })

  it('builds detail with files, license and security from the version endpoint', async () => {
    const detailBody = await fixture('clawhub-detail.json')
    const versionBody = await fixture('clawhub-version-detail.json')
    stubFetch((url) => {
      if (url.includes('/versions/')) return { body: versionBody }
      return { body: detailBody }
    })

    const detail = await clawhubProvider.detail('git')

    expect(detail.slug).toBe('git')
    expect(detail.files.length).toBeGreaterThan(0)
    expect(detail.files[0]!.path).toBe('SKILL.md')
    expect(detail.files[0]!.language).toBe('markdown')
    expect(detail.license).toBeDefined()
    // Fixture security.status === 'clean' → benign
    expect(detail.securityStatus).toBe('benign')
    expect(detail.securityReports?.[0]?.vendor).toBe('clawhub-scan')
    // Description frontmatter is stripped into a body
    expect(detail.description).not.toStartWith('---')
    expect(detail.descriptionFrontmatter).toBeDefined()
  })

  it('fetches raw file content', async () => {
    stubFetch(() => ({ body: '# Hello', contentType: 'text/markdown' }))

    const file = await clawhubProvider.fetchFile('git', 'SKILL.md')

    expect(requestedUrls[0]).toContain('/api/v1/skills/git/file?path=SKILL.md')
    expect(file.content).toBe('# Hello')
    expect(file.size).toBe(7)
  })

  it('resolves ambiguous slugs via the 409 owner hint and remembers the owner', async () => {
    const detailBody = await fixture('clawhub-detail.json')
    const ambiguous = JSON.stringify({
      code: 'AMBIGUOUS_SKILL_SLUG',
      slug: 'git',
      matches: [{ ownerHandle: 'pskoett', slug: 'git', ref: '@pskoett/git' }],
    })
    stubFetch((url) => {
      const parsed = new URL(url)
      if (parsed.pathname.includes('/versions/')) return { body: '{"version":{"files":[]}}' }
      if (parsed.searchParams.get('owner') === 'pskoett') return { body: detailBody }
      return { status: 409, body: ambiguous }
    })

    const detail = await clawhubProvider.detail('git')

    expect(detail.slug).toBe('git')
    // Owner is remembered — subsequent file fetches carry ?owner=
    stubFetch((url) => {
      const parsed = new URL(url)
      if (parsed.searchParams.get('owner') === 'pskoett') return { body: '# ok', contentType: 'text/markdown' }
      return { status: 409, body: ambiguous }
    })
    const file = await clawhubProvider.fetchFile('git', 'SKILL.md')
    expect(file.content).toBe('# ok')
    expect(requestedUrls[requestedUrls.length - 1]).toContain('owner=pskoett')
  })

  it('classifies invalid JSON as a bad-response error', async () => {
    stubFetch(() => ({ body: '<html>oops</html>' }))

    await expect(clawhubProvider.list({ limit: 3 })).rejects.toThrow(MarketUpstreamError)
  })

  it('fails when the provider is disabled via env', async () => {
    process.env.HAHA_MARKET_DISABLE_PROVIDERS = 'clawhub'
    stubFetch(() => ({ body: '{"items":[]}' }))

    await expect(clawhubProvider.list({ limit: 3 })).rejects.toThrow('disabled')
    expect(requestedUrls).toEqual([])
  })
})

describe('clawhubProvider owner pinning', () => {
  const ambiguous = JSON.stringify({
    code: 'AMBIGUOUS_SKILL_SLUG',
    slug: 'git',
    matches: [{ ownerHandle: 'early-copy' }, { ownerHandle: 'ivangdavila' }],
  })

  function ownerAwareUpstream(detailBody: string) {
    stubFetch((url) => {
      const parsed = new URL(url)
      const owner = parsed.searchParams.get('owner')
      if (owner !== 'ivangdavila' && owner !== 'early-copy') return { status: 409, body: ambiguous }
      if (parsed.pathname.endsWith('/file')) return { body: `# by ${owner}`, contentType: 'text/markdown' }
      if (parsed.pathname.includes('/versions/')) return { body: '{"version":{"files":[]}}' }
      const detail = JSON.parse(detailBody)
      detail.owner.handle = owner
      return { body: JSON.stringify(detail) }
    })
  }

  it('sends a catalog owner hint up front instead of taking the 409 first match', async () => {
    ownerAwareUpstream(await fixture('clawhub-detail.json'))
    setClawhubOwnerHints([['git', 'ivangdavila']])

    const detail = await clawhubProvider.detail('git')

    expect(detail.author.handle).toBe('ivangdavila')
    expect(requestedUrls.length).toBeGreaterThan(0)
    expect(requestedUrls.every((url) => new URL(url).searchParams.get('owner') === 'ivangdavila')).toBe(true)
    expect(clawhubOwnerFor('git')).toBe('ivangdavila')
  })

  it('without a hint keeps resolving 409 to the first match', async () => {
    ownerAwareUpstream(await fixture('clawhub-detail.json'))

    const detail = await clawhubProvider.detail('git')

    expect(detail.author.handle).toBe('early-copy')
    expect(new URL(requestedUrls[0]!).searchParams.has('owner')).toBe(false)
  })

  it('throws instead of widening when a pinned owner still answers 409', async () => {
    stubFetch(() => ({ status: 409, body: ambiguous }))
    setClawhubOwnerHints([['git', 'gone-owner']])

    const error = await clawhubProvider.fetchFile('git', 'SKILL.md').catch((caught) => caught)

    expect(error).toBeInstanceOf(MarketUpstreamError)
    expect(String(error.message)).toContain('409')
    // One request with the pinned owner, no retry with a guessed one.
    expect(requestedUrls.length).toBe(1)
    expect(new URL(requestedUrls[0]!).searchParams.get('owner')).toBe('gone-owner')
  })

  it('withClawhubOwner pins one operation over the catalog hint, for that slug only', async () => {
    ownerAwareUpstream(await fixture('clawhub-detail.json'))
    setClawhubOwnerHints([['git', 'ivangdavila']])

    const file = await withClawhubOwner('git', 'early-copy', async () => {
      expect(clawhubOwnerFor('git')).toBe('early-copy')
      expect(clawhubOwnerFor('other-slug')).toBeUndefined()
      return clawhubProvider.fetchFile('git', 'SKILL.md')
    })

    expect(file.content).toBe('# by early-copy')
    // Outside the scope the hint applies again.
    expect(clawhubOwnerFor('git')).toBe('ivangdavila')
    expect((await clawhubProvider.fetchFile('git', 'SKILL.md')).content).toBe('# by ivangdavila')
  })
})

describe('clawhubProvider detail extras', () => {
  async function detailWith(mutate: (detail: any, version: any) => void) {
    const detail = JSON.parse(await fixture('clawhub-detail.json'))
    const version = JSON.parse(await fixture('clawhub-version-detail.json'))
    mutate(detail, version)
    stubFetch((url) => (url.includes('/versions/') ? { body: JSON.stringify(version) } : { body: JSON.stringify(detail) }))
    return clawhubProvider.detail('git')
  }

  it('splits the scan into one report per scanner, each with its own verdict and summary', async () => {
    const detail = await detailWith(() => {})

    const [overall, ...scanners] = detail.securityReports!
    expect(overall!.vendor).toBe('clawhub-scan')
    expect(overall!.statusText).toBe('Clean (with warnings)')
    expect(scanners.map((report) => [report.vendor, report.status])).toEqual([
      ['VirusTotal', 'clean'],
      ['skillspector', 'suspicious'],
      ['LLM review', 'clean'],
    ])
    expect(scanners[0]!.reportUrl).toContain('virustotal.com')
    expect(scanners[1]!.statusText).toBe('suspicious · CAUTION')
    expect(scanners[1]!.reportUrl).toBeUndefined()
    expect(scanners[2]!.summary).toMatch(/Git reference skill/)
    // The overall scan status still decides the badge.
    expect(detail.securityStatus).toBe('benign')
  })

  it('maps the latest version changelog and links the owner-qualified page', async () => {
    const detail = await detailWith(() => {})

    expect(detail.changelog).toEqual({
      version: '1.0.8',
      text: 'Simplified the skill name and kept the stateless activation guidance',
      publishedAt: 1773255795217,
    })
    expect(detail.pageUrl).toBe('https://clawhub.ai/ivangdavila/git')
  })

  it('drops placeholder changelogs stamped by sync pipelines', async () => {
    const detail = await detailWith((raw) => {
      raw.latestVersion.changelog = 'Synced by the skillhub pipeline'
    })

    expect(detail.changelog).toBeUndefined()
    expect(meaningfulChangelog('  synced by pipeline ')).toBeUndefined()
    expect(meaningfulChangelog('   ')).toBeUndefined()
    expect(meaningfulChangelog(42)).toBeUndefined()
    expect(meaningfulChangelog(' Fixed the pipeline docs ')).toBe('Fixed the pipeline docs')
  })

  it('omits pageUrl when the detail has no owner', async () => {
    const detail = await detailWith((raw) => {
      raw.owner = null
    })

    expect(detail.pageUrl).toBeUndefined()
  })
})

describe('skillhubProvider', () => {
  it('uses pageSize (not limit) and keyword (not q) — upstream silently ignores the wrong names', async () => {
    const body = await fixture('skillhub-search.json')
    stubFetch(() => ({ body }))

    await skillhubProvider.search({ q: '小红书', limit: 24 })

    const url = new URL(requestedUrls[0]!)
    expect(url.searchParams.get('pageSize')).toBe('24')
    expect(url.searchParams.get('keyword')).toBe('小红书')
    expect(url.searchParams.has('limit')).toBe(false)
    expect(url.searchParams.has('q')).toBe(false)
  })

  it('unwraps the {code,data,message} envelope and normalizes list items', async () => {
    const body = await fixture('skillhub-list.json')
    stubFetch(() => ({ body }))

    const page = await skillhubProvider.list({ limit: 3 })

    expect(page.items.length).toBeGreaterThan(0)
    const first = page.items[0]!
    expect(first.id).toBe(`skillhub:${first.slug}`)
    expect(first.source).toBe('skillhub')
    expect(typeof first.stats.downloads).toBe('number')
    expect(page.total).toBeGreaterThan(0)
    // total(75k+) far exceeds one page → nextCursor is the next page number
    expect(page.nextCursor).toBe('2')
  })

  it('computes page-based pagination from cursor', async () => {
    const body = await fixture('skillhub-list.json')
    stubFetch(() => ({ body }))

    await skillhubProvider.list({ limit: 24, cursor: '3' })

    const url = new URL(requestedUrls[0]!)
    expect(url.searchParams.get('page')).toBe('3')
  })

  it('stops pagination when page * pageSize >= total', async () => {
    const envelope = { code: 0, data: { skills: [{ slug: 'a', name: 'A' }], total: 3 }, message: 'ok' }
    stubFetch(() => ({ body: JSON.stringify(envelope) }))

    const page = await skillhubProvider.list({ limit: 24 })

    expect(page.nextCursor).toBeUndefined()
  })

  it('rejects a non-zero envelope code as bad response', async () => {
    stubFetch(() => ({ body: '{"code":500,"data":null,"message":"boom"}' }))

    await expect(skillhubProvider.list({ limit: 3 })).rejects.toThrow('code=500')
  })

  it('parses upstream_url on clawhub mirror entries', async () => {
    const envelope = {
      code: 0,
      data: {
        skills: [{
          slug: 'baoyu-skills-wrapper',
          name: 'Baoyu',
          source: 'clawhub',
          upstream_url: 'https://clawhub.ai/dongjie-oss/baoyu-skills-wrapper',
        }],
        total: 1,
      },
    }
    stubFetch(() => ({ body: JSON.stringify(envelope) }))

    const page = await skillhubProvider.list({ limit: 24 })

    expect(page.items[0]!.upstream).toEqual({ source: 'clawhub', slug: 'baoyu-skills-wrapper' })
  })

  it('maps securityReports to benign and preserves report links in detail', async () => {
    const detailBody = await fixture('skillhub-detail.json')
    const filesBody = await fixture('skillhub-files.json')
    stubFetch((url) => {
      if (url.includes('/files')) return { body: filesBody }
      if (url.includes('/file?')) return { body: '---\nname: x\n---\n# Doc', contentType: 'text/markdown' }
      return { body: detailBody }
    })

    const detail = await skillhubProvider.detail('pe-compliance-expert-pro')

    expect(detail.securityStatus).toBe('benign')
    expect(detail.securityReports?.length).toBe(2)
    expect(detail.securityReports?.[0]?.reportUrl).toContain('http')
    expect(detail.files.length).toBeGreaterThan(0)
    // Description comes from the fetched SKILL.md
    expect(detail.description).toContain('# Doc')
  })

  it('flags a skill when any security report is non-benign', async () => {
    const detail = JSON.parse(await fixture('skillhub-detail.json'))
    detail.securityReports.keen.status = 'malicious'
    stubFetch((url) => {
      if (url.includes('/files')) return { body: '{"count":0,"files":[]}' }
      return { body: JSON.stringify(detail) }
    })

    const result = await skillhubProvider.detail('pe-compliance-expert-pro')

    expect(result.securityStatus).toBe('flagged')
  })

  it('maps a meaningful latest-version changelog in detail', async () => {
    const detailBody = await fixture('skillhub-detail.json')
    stubFetch((url) => (url.includes('/files') ? { body: '{"count":0,"files":[]}' } : { body: detailBody }))

    const detail = await skillhubProvider.detail('pe-compliance-expert-pro')

    expect(detail.changelog).toEqual({ version: '1.0.2', text: '根据最新的监管要求进行skill的思考炼化', publishedAt: 1777381898516 })
    expect(detail.pageUrl).toBeUndefined()
  })

  it('drops a pipeline placeholder changelog in detail', async () => {
    const detail = JSON.parse(await fixture('skillhub-detail.json'))
    detail.latestVersion.changelog = 'synced by clawhub pipeline'
    stubFetch((url) => (url.includes('/files') ? { body: '{"count":0,"files":[]}' } : { body: JSON.stringify(detail) }))

    const result = await skillhubProvider.detail('pe-compliance-expert-pro')

    expect(result.changelog).toBeUndefined()
  })

  it('marks list items verified only via the verified field', async () => {
    const envelope = {
      code: 0,
      data: { skills: [{ slug: 'a', name: 'A', verified: true }, { slug: 'b', name: 'B' }], total: 2 },
    }
    stubFetch(() => ({ body: JSON.stringify(envelope) }))

    const page = await skillhubProvider.list({ limit: 24 })

    expect(page.items[0]!.securityStatus).toBe('verified')
    expect(page.items[1]!.securityStatus).toBe('unknown')
  })
})
