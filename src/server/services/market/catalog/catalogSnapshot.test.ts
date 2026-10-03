import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { CatalogEntry, CatalogFile } from './catalog.js'
import {
  buildCatalogSnapshot,
  clawhubVerdict,
  curationEntriesToRead,
  orderForHome,
  readClawhubEntry,
  readSkillhubEntry,
  skillhubVerdict,
  type CatalogRead,
  type CurationEntry,
  type CurationFile,
  type LiveRead,
  type UpstreamVerdict,
} from './catalogSnapshot.js'

const FIXTURES = path.join(import.meta.dir, '..', '..', '..', '__tests__', 'fixtures', 'market')

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf-8')) as T
}

const categories = [
  { key: 'a', name: '甲', nameEn: 'A' },
  { key: 'b', name: '乙', nameEn: 'B' },
]

function curationEntry(overrides: Partial<CurationEntry> = {}): CurationEntry {
  return { source: 'clawhub', slug: 'demo', owner: 'alice', category: 'a', summary: '演示', tags: ['标签'], ...overrides }
}

function liveRead(overrides: Partial<LiveRead> = {}): LiveRead {
  return { name: 'Demo', stats: { downloads: 1 }, verdict: 'clean', reasons: [], ...overrides }
}

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    source: 'clawhub', slug: 'x', owner: 'o', name: 'x', summary: 's', category: 'a', tags: [],
    stats: { downloads: 0 }, security: 'benign', ...overrides,
  }
}

describe('buildCatalogSnapshot', () => {
  it('reproduces the shipped skills.json from curation.json and the reads behind it', async () => {
    const curation = await readJson<CurationFile>(path.join(import.meta.dir, 'curation.json'))
    const shipped = await readJson<CatalogFile>(path.join(import.meta.dir, 'skills.json'))
    const curated = new Map(curation.skills.map((item) => [`${item.source}:${item.slug}`, item]))
    const verdicts: Record<string, UpstreamVerdict> = { benign: 'clean', flagged: 'suspicious', verified: 'verified', unknown: 'unknown' }
    const reads = new Map<string, CatalogRead>()
    for (const item of shipped.skills) {
      const id = `${item.source}:${item.slug}`
      const allow = curated.get(id)?.allowSuspicious
      const note = item.securityNote ?? ''
      const reasons = !note || note === allow ? [] : [allow && note.startsWith(`${allow}; `) ? note.slice(allow.length + 2) : note]
      reads.set(id, {
        name: item.name,
        summaryEn: item.summaryEn,
        stats: item.stats,
        version: item.version,
        updatedAt: item.updatedAt,
        license: item.license,
        iconUrl: item.iconUrl,
        requiresApiKey: item.requiresApiKey,
        verdict: verdicts[item.security]!,
        reasons,
      })
    }

    const { snapshot, problems } = buildCatalogSnapshot(curation, reads, shipped.generatedAt)

    expect(problems).toEqual([])
    // Byte-for-byte: the refresh script writes exactly this serialization.
    expect(`${JSON.stringify(snapshot, null, 1)}\n`).toBe(await fs.readFile(path.join(import.meta.dir, 'skills.json'), 'utf-8'))
  })

  it('drops duplicates, unknown categories, missing reads, malicious and unexplained suspicious entries', () => {
    const curation: CurationFile = {
      categories,
      skills: [
        curationEntry({ slug: 'keep' }),
        curationEntry({ slug: 'keep', summary: 'second copy' }),
        curationEntry({ slug: 'lost-category', category: 'zzz' }),
        curationEntry({ slug: 'moved' }),
        curationEntry({ slug: 'evil' }),
        curationEntry({ slug: 'shady' }),
        curationEntry({ slug: 'unread' }),
      ],
    }
    const reads = new Map<string, CatalogRead>([
      ['clawhub:keep', liveRead()],
      ['clawhub:moved', { missing: 'owner is now mallory' }],
      ['clawhub:evil', liveRead({ verdict: 'malicious' })],
      ['clawhub:shady', liveRead({ verdict: 'suspicious', reasons: ['skillspector: DO_NOT_INSTALL'] })],
    ])

    const { snapshot, problems } = buildCatalogSnapshot(curation, reads, 123)

    expect(snapshot.skills.map((item) => item.slug)).toEqual(['keep'])
    expect(snapshot.skills[0]!.summary).toBe('演示')
    expect(snapshot.generatedAt).toBe(123)
    expect(problems).toEqual([
      'clawhub:keep: duplicate entry',
      'clawhub:lost-category: unknown category zzz',
      'clawhub:moved: owner is now mallory',
      'clawhub:evil: upstream verdict: malicious',
      'clawhub:shady: suspicious (skillspector: DO_NOT_INSTALL)',
      'clawhub:unread: not read',
    ])
  })

  it('ships an allowed suspicious entry as flagged with the editorial reason first', () => {
    const curation: CurationFile = {
      categories,
      skills: [curationEntry({ slug: 'shady', allowSuspicious: '审核意见' })],
    }
    const reads = new Map<string, CatalogRead>([
      ['clawhub:shady', liveRead({ verdict: 'suspicious', reasons: ['skillspector: CAUTION', 'llm review: suspicious'] })],
    ])

    const [shipped] = buildCatalogSnapshot(curation, reads, 1).snapshot.skills

    expect(shipped!.security).toBe('flagged')
    expect(shipped!.securityNote).toBe('审核意见; skillspector: CAUTION; llm review: suspicious')
  })

  it('maps verdicts to card security and omits empty fields', () => {
    const curation: CurationFile = {
      categories,
      skills: [
        curationEntry({ slug: 'v', source: 'skillhub' }),
        curationEntry({ slug: 'c' }),
        curationEntry({ slug: 'u', tags: undefined }),
      ],
    }
    const reads = new Map<string, CatalogRead>([
      ['skillhub:v', liveRead({ verdict: 'verified' })],
      ['clawhub:c', liveRead({ verdict: 'clean', reasons: ['skillspector: CAUTION'] })],
      ['clawhub:u', liveRead({ verdict: 'unknown' })],
    ])

    const skills = buildCatalogSnapshot(curation, reads, 1).snapshot.skills
    const bySlug = new Map(skills.map((item) => [item.slug, item]))

    expect(bySlug.get('v')!.security).toBe('verified')
    expect(bySlug.get('c')!.security).toBe('benign')
    expect(bySlug.get('c')!.securityNote).toBeUndefined()
    expect(bySlug.get('u')!.security).toBe('unknown')
    expect(bySlug.get('u')!.tags).toEqual([])
    expect('featured' in bySlug.get('u')!).toBe(false)
    expect('version' in bySlug.get('u')!).toBe(false)
  })
})

describe('orderForHome', () => {
  it('ranks by download percentile within each source, not raw downloads', () => {
    const skills = [
      entry({ slug: 'ch-low', source: 'clawhub', stats: { downloads: 10 } }),
      entry({ slug: 'sh-mid', source: 'skillhub', stats: { downloads: 500_000 } }),
      entry({ slug: 'ch-top', source: 'clawhub', stats: { downloads: 100 } }),
      entry({ slug: 'sh-top', source: 'skillhub', stats: { downloads: 1_000_000 } }),
      entry({ slug: 'sh-low', source: 'skillhub', stats: { downloads: 1 } }),
    ]

    expect(orderForHome(categories, skills).map((item) => item.slug)).toEqual(['ch-top', 'sh-top', 'sh-mid', 'ch-low', 'sh-low'])
  })

  it('deals editor\'s picks round-robin across categories ahead of everything else', () => {
    const skills = [
      entry({ slug: 'plain-hot', stats: { downloads: 1_000 } }),
      entry({ slug: 'a-pick-2', category: 'a', featured: true, stats: { downloads: 50 } }),
      entry({ slug: 'a-pick-1', category: 'a', featured: true, stats: { downloads: 90 } }),
      entry({ slug: 'a-pick-3', category: 'a', featured: true, stats: { downloads: 20 } }),
      entry({ slug: 'b-pick-1', category: 'b', featured: true, stats: { downloads: 5 } }),
    ]

    expect(orderForHome(categories, skills).map((item) => item.slug)).toEqual([
      'a-pick-1', 'b-pick-1', 'a-pick-2', 'a-pick-3', 'plain-hot',
    ])
  })
})

describe('upstream verdicts', () => {
  it('reads ClawHub moderation before the version scan', () => {
    expect(clawhubVerdict({ moderation: { isMalwareBlocked: true } }, {}).verdict).toBe('malicious')
    expect(clawhubVerdict({ moderation: { verdict: 'malicious' } }, { version: { security: { status: 'clean' } } }).verdict).toBe('malicious')
    expect(clawhubVerdict({}, { version: { security: { status: 'malicious' } } }).verdict).toBe('malicious')
    expect(clawhubVerdict({ moderation: { isSuspicious: true } }, { version: { security: { status: 'clean' } } }).verdict).toBe('suspicious')
    expect(clawhubVerdict({}, { version: { security: { status: 'suspicious' } } }).verdict).toBe('suspicious')
    expect(clawhubVerdict({ moderation: { verdict: 'clean' } }, {}).verdict).toBe('clean')
    expect(clawhubVerdict({ moderation: null }, {}).verdict).toBe('unknown')
  })

  it('collects ClawHub scanner objections as reasons', async () => {
    const version = await readJson<any>(path.join(FIXTURES, 'clawhub-version-detail.json'))
    version.version.security.scanners.vt.normalizedStatus = 'suspicious'
    version.version.security.scanners.llm.normalizedStatus = 'suspicious'

    expect(clawhubVerdict({}, version)).toEqual({
      verdict: 'clean',
      reasons: ['skillspector: CAUTION', 'llm review: suspicious', 'VirusTotal: suspicious'],
    })
  })

  it('ignores SkillHub scans that have no verdict yet', () => {
    expect(skillhubVerdict({ securityReports: { a: { status: 'queued' }, b: { status: 'pending' } } })).toEqual({ verdict: 'unknown', reasons: [] })
    expect(skillhubVerdict({ securityReports: { a: { status: 'Benign' }, b: { status: 'pending' } } })).toEqual({ verdict: 'clean', reasons: ['reports: benign'] })
    expect(skillhubVerdict({ skill: { verified: true }, securityReports: { a: { status: 'safe' } } }).verdict).toBe('verified')
    expect(skillhubVerdict({ securityReports: { a: { status: 'benign' }, b: { status: 'risky' } } }).verdict).toBe('suspicious')
    expect(skillhubVerdict({ securityReports: { a: { status: 'risky' }, b: { status: 'malicious' } } }).verdict).toBe('malicious')
    expect(skillhubVerdict({}).verdict).toBe('unknown')
  })
})

describe('upstream reads', () => {
  it('reads a ClawHub entry from its detail and version fixtures', async () => {
    const detail = await readJson<any>(path.join(FIXTURES, 'clawhub-detail.json'))
    const version = await readJson<any>(path.join(FIXTURES, 'clawhub-version-detail.json'))

    const read = readClawhubEntry(curationEntry({ slug: detail.skill.slug, owner: 'ivangdavila' }), detail, version)

    expect(read).toEqual({
      name: 'Git',
      summaryEn: detail.skill.summary,
      stats: { downloads: 16142, installs: 510, stars: 31 },
      version: '1.0.8',
      updatedAt: detail.skill.updatedAt,
      license: 'MIT-0',
      verdict: 'clean',
      reasons: ['skillspector: CAUTION'],
    })
  })

  it('reports a ClawHub entry whose owner changed or that no longer resolves', async () => {
    const detail = await readJson<any>(path.join(FIXTURES, 'clawhub-detail.json'))

    expect(readClawhubEntry(curationEntry({ owner: 'someone' }), detail, {})).toEqual({ missing: 'owner is now ivangdavila' })
    expect(readClawhubEntry(curationEntry(), { _status: 404 }, {})).toEqual({ missing: 'clawhub detail 404' })
  })

  it('reads a SkillHub entry and checks it still resolves to the curated owner', async () => {
    const detail = await readJson<any>(path.join(FIXTURES, 'skillhub-detail.json'))
    const curated = curationEntry({ source: 'skillhub', slug: detail.skill.slug, owner: 'user_378eb7ca' })

    const read = readSkillhubEntry(curated, detail)

    expect(read).toMatchObject({
      name: '私募合规',
      stats: { downloads: 1978, installs: 40, stars: 1 },
      version: '1.0.2',
      verdict: 'clean',
      iconUrl: detail.skill.iconUrl,
    })
    expect((read as LiveRead).requiresApiKey).toBeUndefined()
    expect(readSkillhubEntry({ ...curated, owner: 'other' }, detail)).toEqual({ missing: 'slug now resolves to user_378eb7ca' })
    expect(readSkillhubEntry(curated, { _error: 'timeout' })).toEqual({ missing: 'skillhub detail timeout' })
  })
})

describe('curationEntriesToRead', () => {
  it('reads each id once and skips entries in unknown categories', () => {
    const toRead = curationEntriesToRead({
      categories,
      skills: [
        curationEntry({ slug: 'one' }),
        curationEntry({ slug: 'one', summary: 'dup' }),
        curationEntry({ slug: 'one', source: 'skillhub' }),
        curationEntry({ slug: 'bad', category: 'zzz' }),
      ],
    })

    expect(toRead.map((item) => `${item.source}:${item.slug}`)).toEqual(['clawhub:one', 'skillhub:one'])
  })
})
