import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleMarketApi } from '../api/market.js'
import { resetMarketCacheForTests } from '../services/market/cache.js'
import { resetInstallLocksForTests } from '../services/market/installService.js'

const FIXTURES = path.join(import.meta.dir, 'fixtures', 'market')

let tmpHome: string
let originalClaudeConfigDir: string | undefined
const originalFetch = globalThis.fetch

async function fixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES, name), 'utf-8')
}

function request(pathname: string, init?: RequestInit): { req: Request; url: URL; segments: string[] } {
  const url = new URL(`http://localhost:3456${pathname}`)
  const req = new Request(url, init)
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

async function call(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const { req, url, segments } = request(pathname, init)
  const res = await handleMarketApi(req, url, segments)
  return { status: res.status, body: await res.json() }
}

beforeEach(async () => {
  resetMarketCacheForTests()
  resetInstallLocksForTests()
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'market-api-test-'))
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  delete process.env.HAHA_MARKET_DISABLE_PROVIDERS
  await fs.rm(tmpHome, { recursive: true, force: true })
})

function stubUpstreams(handler: (url: string) => { status?: number; body: string } | undefined) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const result = handler(url)
    if (!result) return new Response('Not found', { status: 404 })
    return new Response(result.body, { status: result.status ?? 200 })
  }) as typeof fetch
}

describe('GET /api/market/skills', () => {
  it('returns aggregated items with source statuses', async () => {
    const clawhubBody = await fixture('clawhub-list.json')
    const skillhubBody = await fixture('skillhub-list.json')
    stubUpstreams((url) => (url.includes('clawhub.ai') ? { body: clawhubBody } : { body: skillhubBody }))

    const { status, body } = await call('/api/market/skills?limit=3')

    expect(status).toBe(200)
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.sources.clawhub.status).toBe('ok')
    expect(body.sources.skillhub.status).toBe('ok')
    expect(typeof body.nextCursor === 'string' || body.nextCursor === null).toBe(true)
  })

  it('rejects invalid filters with 400', async () => {
    expect((await call('/api/market/skills?source=evil')).status).toBe(400)
    expect((await call('/api/market/skills?security=hacked')).status).toBe(400)
    expect((await call('/api/market/skills?installed=nope')).status).toBe(400)
  })

  it('reports failed status when a provider is disabled via env', async () => {
    process.env.HAHA_MARKET_DISABLE_PROVIDERS = 'skillhub'
    const clawhubBody = await fixture('clawhub-list.json')
    stubUpstreams((url) => (url.includes('clawhub.ai') ? { body: clawhubBody } : undefined))

    const { status, body } = await call('/api/market/skills?limit=3')

    expect(status).toBe(200)
    expect(body.items.length).toBeGreaterThan(0)
    expect(['failed', 'degraded']).toContain(body.sources.skillhub.status)
  })
})

describe('GET /api/market/skills/{source}/{slug}', () => {
  it('returns the detail payload', async () => {
    const detailBody = await fixture('clawhub-detail.json')
    const versionBody = await fixture('clawhub-version-detail.json')
    stubUpstreams((url) => (url.includes('/versions/') ? { body: versionBody } : { body: detailBody }))

    const { status, body } = await call('/api/market/skills/clawhub/git')

    expect(status).toBe(200)
    expect(body.skill.slug).toBe('git')
    expect(body.skill.files.length).toBeGreaterThan(0)
    expect(body.skill.installState).toBe('installable')
    expect(body.sourceStatus.status).toBe('ok')
  })

  it('rejects an unknown source with 400', async () => {
    expect((await call('/api/market/skills/npm/git')).status).toBe(400)
  })

  it('rejects slugs with path traversal', async () => {
    expect((await call('/api/market/skills/clawhub/..%2Fetc')).status).toBe(400)
  })
})

describe('GET /api/market/skills/{source}/{slug}/file', () => {
  it('returns file content with language and size', async () => {
    stubUpstreams(() => ({ body: '# Hello world' }))

    const { status, body } = await call('/api/market/skills/clawhub/git/file?path=SKILL.md')

    expect(status).toBe(200)
    expect(body.file.content).toBe('# Hello world')
    expect(body.file.language).toBe('markdown')
    expect(body.file.truncated).toBe(false)
  })

  it('rejects unsafe paths', async () => {
    expect((await call('/api/market/skills/clawhub/git/file?path=../../etc/passwd')).status).toBe(400)
    expect((await call('/api/market/skills/clawhub/git/file?path=/etc/passwd')).status).toBe(400)
    expect((await call('/api/market/skills/clawhub/git/file')).status).toBe(400)
  })
})

describe('POST /api/market/install & uninstall', () => {
  it('rejects a malformed id with 400', async () => {
    const bad = await call('/api/market/install', {
      method: 'POST',
      body: JSON.stringify({ id: 'no-colon' }),
    })
    expect(bad.status).toBe(400)

    const missing = await call('/api/market/install', { method: 'POST', body: '{}' })
    expect(missing.status).toBe(400)

    const badJson = await call('/api/market/install', { method: 'POST', body: 'not-json' })
    expect(badJson.status).toBe(400)
  })

  it('propagates typed install errors', async () => {
    process.env.HAHA_MARKET_DISABLE_PROVIDERS = 'clawhub,skillhub'

    const { status, body } = await call('/api/market/install', {
      method: 'POST',
      body: JSON.stringify({ id: 'clawhub:demo' }),
    })

    expect(status).toBe(502)
    expect(body.error).toContain('MARKET')
  })

  it('uninstall 404s when nothing is installed', async () => {
    const { status } = await call('/api/market/uninstall', {
      method: 'POST',
      body: JSON.stringify({ id: 'clawhub:ghost' }),
    })
    expect(status).toBe(404)
  })
})

describe('GET /api/market/status & method guard', () => {
  it('returns per-source health', async () => {
    const { status, body } = await call('/api/market/status')

    expect(status).toBe(200)
    expect(body.sources.clawhub.status).toBeDefined()
    expect(body.sources.skillhub.status).toBeDefined()
  })

  it('405s on unknown routes', async () => {
    expect((await call('/api/market/nonsense')).status).toBe(405)
    expect((await call('/api/market/skills', { method: 'DELETE' })).status).toBe(405)
  })
})
