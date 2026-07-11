import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resetMarketCacheForTests } from '../services/market/cache.js'
import {
  annotateInstallState,
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

    const result = await listMarketSkills({ source: 'all', limit: 3 })

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

    const result = await listMarketSkills({ source: 'all', limit: 3 })

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
    await listMarketSkills({ source: 'all', limit: 3 })

    // Now both upstreams fail — but entries are cached (fresh) so still ok/fromCache.
    stubFetch(() => ({ status: 500, body: 'down' }))
    const result = await listMarketSkills({ source: 'all', limit: 3 })

    expect(result.items.length).toBeGreaterThan(0)
    expect(result.sources.clawhub.fromCache).toBe(true)
  })

  it('respects the source filter', async () => {
    const clawhubBody = await fixture('clawhub-list.json')
    stubFetch((url) => {
      if (url.includes('clawhub.ai')) return { body: clawhubBody }
      return { status: 500, body: 'should not be called' }
    })

    const result = await listMarketSkills({ source: 'clawhub', limit: 3 })

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

    const installed = await listMarketSkills({ source: 'clawhub', limit: 3, installed: 'installed' })
    expect(installed.items.length).toBe(1)
    expect(installed.items[0]!.slug).toBe(slug)

    resetMarketCacheForTests()
    const notInstalled = await listMarketSkills({ source: 'clawhub', limit: 3, installed: 'installable' })
    expect(notInstalled.items.every((i) => i.slug !== slug)).toBe(true)
  })

  it('filters by security status', async () => {
    const envelope = {
      code: 0,
      data: { skills: [{ slug: 'a', name: 'A', verified: true }, { slug: 'b', name: 'B' }], total: 2 },
    }
    stubFetch((url) => (url.includes('skillhub') ? { body: JSON.stringify(envelope) } : { body: '{"items":[]}' }))

    const result = await listMarketSkills({ source: 'skillhub', limit: 24, security: 'verified' })

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
