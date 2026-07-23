import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleSearchApi } from '../api/search.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

describe('Search API session content gate', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalHome: string | undefined
  let originalUserProfile: string | undefined
  let originalSearchIndex: string | undefined

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `claude-search-api-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(tmpDir, { recursive: true })
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalSearchIndex = process.env.CC_HAHA_SEARCH_INDEX
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.HOME = tmpDir
    process.env.USERPROFILE = tmpDir
    delete process.env.CC_HAHA_SEARCH_INDEX
    resetSettingsCache()
  })

  afterEach(async () => {
    resetSettingsCache()
    if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile
    else delete process.env.USERPROFILE
    if (originalSearchIndex !== undefined) process.env.CC_HAHA_SEARCH_INDEX = originalSearchIndex
    else delete process.env.CC_HAHA_SEARCH_INDEX
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns 409 when session content search is disabled in user settings', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ sessionContentSearchEnabled: false }, null, 2),
    )
    resetSettingsCache()

    const req = new Request('http://127.0.0.1/api/search/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hello' }),
    })
    const res = await handleSearchApi(req, new URL(req.url), ['api', 'search', 'sessions'])
    expect(res.status).toBe(409)
    const body = await res.json() as { error?: string; code?: string }
    expect(body.error === 'SESSION_CONTENT_SEARCH_DISABLED' || body.code === 'SESSION_CONTENT_SEARCH_DISABLED').toBe(true)
  })
})
