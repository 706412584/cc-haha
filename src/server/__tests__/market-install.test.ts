import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resetMarketCacheForTests } from '../services/market/cache.js'
import {
  installMarketSkill,
  resetInstallLocksForTests,
  uninstallMarketSkill,
} from '../services/market/installService.js'
import { ApiError } from '../middleware/errorHandler.js'

let tmpHome: string
let originalClaudeConfigDir: string | undefined
const originalFetch = globalThis.fetch

const SKILL_MD = '---\nname: demo\n---\n# Demo skill'
const HELPER_PY = 'print("hello")\n'

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

type FileSpec = { path: string; content: string; sha256?: string | null }

/**
 * Stubs the ClawHub API surface used by install:
 * detail → versions/{v} (file list) → file?path= for each file.
 */
function stubClawhub(files: FileSpec[], opts: { corruptPath?: string } = {}) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url)
    if (parsed.pathname.includes('/file')) {
      const filePath = parsed.searchParams.get('path')
      const file = files.find((f) => f.path === filePath)
      if (!file) return new Response('Not found', { status: 404 })
      const content = opts.corruptPath === file.path ? `${file.content}<tampered>` : file.content
      return new Response(content, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }
    if (parsed.pathname.includes('/versions/')) {
      return Response.json({
        version: {
          version: '1.0.0',
          license: 'MIT',
          files: files.map((f) => ({
            path: f.path,
            size: Buffer.byteLength(f.content, 'utf-8'),
            sha256: f.sha256 === null ? undefined : (f.sha256 ?? sha256(f.content)),
          })),
        },
      })
    }
    // detail
    return Response.json({
      skill: { slug: 'demo', displayName: 'Demo', summary: 'demo', description: SKILL_MD },
      latestVersion: { version: '1.0.0' },
      owner: { handle: 'alice' },
    })
  }) as typeof fetch
}

beforeEach(async () => {
  resetMarketCacheForTests()
  resetInstallLocksForTests()
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'market-install-test-'))
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('installMarketSkill', () => {
  it('downloads, verifies and installs a skill with market meta', async () => {
    stubClawhub([
      { path: 'SKILL.md', content: SKILL_MD },
      { path: 'scripts/helper.py', content: HELPER_PY },
    ])

    const result = await installMarketSkill('clawhub', 'demo')

    expect(result.skill.installState).toBe('installed')
    const installed = path.join(tmpHome, '.claude', 'skills', 'demo')
    expect(result.installedPath).toBe(installed)
    expect(await fs.readFile(path.join(installed, 'SKILL.md'), 'utf-8')).toBe(SKILL_MD)
    expect(await fs.readFile(path.join(installed, 'scripts', 'helper.py'), 'utf-8')).toBe(HELPER_PY)
    const meta = JSON.parse(await fs.readFile(path.join(installed, '.market-meta.json'), 'utf-8'))
    expect(meta.id).toBe('clawhub:demo')
    expect(meta.version).toBe('1.0.0')
    expect(meta.fileCount).toBe(2)
  })

  it('aborts on checksum mismatch and leaves no residue', async () => {
    stubClawhub(
      [
        { path: 'SKILL.md', content: SKILL_MD },
        { path: 'scripts/helper.py', content: HELPER_PY },
      ],
      { corruptPath: 'scripts/helper.py' },
    )

    await expect(installMarketSkill('clawhub', 'demo')).rejects.toThrow('Checksum mismatch')
    const exists = await fs.stat(path.join(tmpHome, '.claude', 'skills', 'demo')).catch(() => null)
    expect(exists).toBeNull()
  })

  it('skips checksum verification when the upstream provides no sha256', async () => {
    stubClawhub([{ path: 'SKILL.md', content: SKILL_MD, sha256: null }])

    const result = await installMarketSkill('clawhub', 'demo')

    expect(result.skill.installState).toBe('installed')
  })

  it('rejects a second install while the target directory already exists', async () => {
    stubClawhub([{ path: 'SKILL.md', content: SKILL_MD }])
    await installMarketSkill('clawhub', 'demo')
    resetMarketCacheForTests()
    stubClawhub([{ path: 'SKILL.md', content: SKILL_MD }])

    try {
      await installMarketSkill('clawhub', 'demo')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).statusCode).toBe(409)
    }
  })

  it('rejects concurrent installs of the same slug with 409', async () => {
    stubClawhub([{ path: 'SKILL.md', content: SKILL_MD }])

    const first = installMarketSkill('clawhub', 'demo')
    const secondError = await installMarketSkill('clawhub', 'demo').catch((e) => e)

    expect(secondError).toBeInstanceOf(ApiError)
    expect((secondError as ApiError).code).toBe('MARKET_INSTALL_IN_PROGRESS')
    await first
  })

  it('rejects skills containing unsafe file paths', async () => {
    stubClawhub([
      { path: 'SKILL.md', content: SKILL_MD },
      { path: '../escape.sh', content: 'echo pwned' },
    ])

    try {
      await installMarketSkill('clawhub', 'demo')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ApiError).statusCode).toBe(422)
    }
    const escaped = await fs.stat(path.join(tmpHome, '.claude', 'escape.sh')).catch(() => null)
    expect(escaped).toBeNull()
  })

  it('rejects skills without SKILL.md', async () => {
    stubClawhub([{ path: 'README.md', content: '# readme' }])

    try {
      await installMarketSkill('clawhub', 'demo')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ApiError).code).toBe('MARKET_NOT_INSTALLABLE')
    }
  })
})

describe('uninstallMarketSkill', () => {
  it('removes a market-installed skill', async () => {
    stubClawhub([{ path: 'SKILL.md', content: SKILL_MD }])
    await installMarketSkill('clawhub', 'demo')
    resetMarketCacheForTests()
    stubClawhub([{ path: 'SKILL.md', content: SKILL_MD }])

    const result = await uninstallMarketSkill('clawhub', 'demo')

    const exists = await fs.stat(path.join(tmpHome, '.claude', 'skills', 'demo')).catch(() => null)
    expect(exists).toBeNull()
    expect(result.skill?.installState).toBe('installable')
  })

  it('refuses to delete a directory the market did not create', async () => {
    const manual = path.join(tmpHome, '.claude', 'skills', 'handmade')
    await fs.mkdir(manual, { recursive: true })
    await fs.writeFile(path.join(manual, 'SKILL.md'), '# mine')

    try {
      await uninstallMarketSkill('clawhub', 'handmade')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ApiError).code).toBe('MARKET_NOT_MANAGED')
    }
    expect(await fs.stat(manual).catch(() => null)).not.toBeNull()
  })

  it('404s for a skill that is not installed', async () => {
    try {
      await uninstallMarketSkill('clawhub', 'ghost')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ApiError).statusCode).toBe(404)
    }
  })
})
