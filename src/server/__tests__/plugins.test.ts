import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'
import { isEnabledPluginSettingValue } from '../../utils/plugins/dependencyResolver.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache, loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { plainTextStorage } from '../../utils/secureStorage/plainTextStorage.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handlePluginsApi } from '../api/plugins.js'
import { conversationService } from '../services/conversationService.js'
import { __resetWebSocketHandlerStateForTests, getSlashCommands } from '../ws/handler.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalHasSession: typeof conversationService.hasSession
let originalRequestControl: typeof conversationService.requestControl

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

describe('Plugins API', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-plugins-api-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    clearInstalledPluginsCache()
    clearPluginCache('plugins-api-test-setup')
    resetSettingsCache()
    __resetWebSocketHandlerStateForTests()
    originalHasSession = conversationService.hasSession.bind(conversationService)
    originalRequestControl = conversationService.requestControl.bind(conversationService)
  })

  afterEach(async () => {
    conversationService.hasSession = originalHasSession
    conversationService.requestControl = originalRequestControl
    __resetWebSocketHandlerStateForTests()
    clearInstalledPluginsCache()
    clearPluginCache('plugins-api-test-teardown')
    resetSettingsCache()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('GET /api/plugins returns an empty plugin list for a clean config', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/plugins')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      plugins: unknown[]
      marketplaces: unknown[]
      summary: { total: number; enabled: number; errorCount: number }
    }

    expect(body.plugins).toEqual([])
    expect(Array.isArray(body.marketplaces)).toBe(true)
    expect(body.summary.total).toBe(0)
    expect(body.summary.enabled).toBe(0)
    expect(body.summary.errorCount).toBe(0)
  })

  it('treats enabledPlugins version constraint arrays as enabled plugins', async () => {
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'demo')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json')

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        description: 'Demo plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'demo',
            source: './plugins/demo',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: {
          'demo@test-market': ['^1.0.0'],
        },
      }),
      'utf-8',
    )

    expect(isEnabledPluginSettingValue(true)).toBe(true)
    expect(isEnabledPluginSettingValue(['^1.0.0'])).toBe(true)
    expect(isEnabledPluginSettingValue(false)).toBe(false)
    expect(isEnabledPluginSettingValue(undefined)).toBe(false)

    const cacheOnlyResult = await loadAllPluginsCacheOnly()
    expect(cacheOnlyResult.enabled).toContainEqual(
      expect.objectContaining({ source: 'demo@test-market', enabled: true }),
    )

    clearPluginCache('plugins-api-test-full-load')

    const { req, url, segments } = makeRequest('GET', '/api/plugins')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      plugins: Array<{ id: string; enabled: boolean }>
      summary: { enabled: number }
    }
    expect(body.plugins).toContainEqual(
      expect.objectContaining({ id: 'demo@test-market', enabled: true }),
    )
    expect(body.summary.enabled).toBe(1)
  })

  it('POST /api/plugins/reload returns numeric counters', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/reload', {})
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      ok: boolean
      summary: Record<string, number>
    }

    expect(body.ok).toBe(true)
    expect(typeof body.summary.enabled).toBe('number')
    expect(typeof body.summary.skills).toBe('number')
    expect(typeof body.summary.errors).toBe('number')
  })

  it('POST /api/plugins/reload hot-reloads an active CLI session and updates slash commands', async () => {
    const controlRequests: Array<{ sessionId: string; request: Record<string, unknown> }> = []
    conversationService.hasSession = ((sessionId: string) => sessionId === 'session-plugins') as typeof conversationService.hasSession
    conversationService.requestControl = (async (
      sessionId: string,
      request: Record<string, unknown>,
    ) => {
      controlRequests.push({ sessionId, request })
      return {
        commands: [
          {
            name: 'draw:render',
            description: 'Render a drawing.',
            argumentHint: '<prompt>',
          },
        ],
        agents: [{ name: 'draw-agent' }],
        plugins: [{ name: 'draw', path: '/tmp/draw', source: 'draw@test' }],
        mcpServers: [{ name: 'plugin:draw:server', type: 'connected' }],
        error_count: 0,
      }
    }) as typeof conversationService.requestControl

    const { req, url, segments } = makeRequest(
      'POST',
      '/api/plugins/reload?sessionId=session-plugins',
      {},
    )
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      session: {
        applied: boolean
        commands: number
        agents: number
        plugins: number
        mcpServers: number
        errors: number
      }
    }

    expect(controlRequests).toEqual([
      {
        sessionId: 'session-plugins',
        request: { subtype: 'reload_plugins' },
      },
    ])
    expect(body.session).toEqual({
      applied: true,
      commands: 1,
      agents: 1,
      plugins: 1,
      mcpServers: 1,
      errors: 0,
    })
    expect(getSlashCommands('session-plugins')).toEqual([
      {
        name: 'draw:render',
        description: 'Render a drawing.',
        argumentHint: '<prompt>',
      },
    ])
  })

  it('refreshActivePlugins rereads settings after an external enable toggle', async () => {
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'draw')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'skills', 'paint'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'draw',
        version: '1.0.0',
        description: 'Drawing plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'commands', 'render.md'),
      '---\ndescription: Render a drawing.\n---\nRender this drawing.',
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'skills', 'paint', 'SKILL.md'),
      '---\ndescription: Paint with the drawing plugin.\n---\nPaint this drawing.',
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'draw',
            source: './plugins/draw',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    const settingsPath = path.join(tmpDir, 'settings.json')
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': false,
        },
      }),
      'utf-8',
    )

    const disabledResult = await loadAllPluginsCacheOnly()
    expect(disabledResult.enabled).toEqual([])
    expect(disabledResult.disabled).toContainEqual(
      expect.objectContaining({ source: 'draw@test-market', enabled: false }),
    )

    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': true,
        },
      }),
      'utf-8',
    )

    let appState = {
      plugins: {
        enabled: [],
        disabled: disabledResult.disabled,
        commands: [],
        errors: [],
        needsRefresh: true,
      },
      mcp: { pluginReconnectKey: 0 },
      agentDefinitions: { allAgents: [], errors: [] },
    } as unknown as AppState

    const result = await refreshActivePlugins(updater => {
      appState = updater(appState)
    })

    expect(result.enabled_count).toBe(1)
    expect(result.command_count).toBe(1)
    expect(result.skill_count).toBe(1)
    expect(result.pluginCommands).toContainEqual(
      expect.objectContaining({
        name: 'draw:render',
        description: 'Render a drawing.',
      }),
    )
    expect(result.pluginSkills).toContainEqual(
      expect.objectContaining({
        name: 'draw:paint',
        description: 'Paint with the drawing plugin.',
      }),
    )
    expect(appState.plugins.commands).toContainEqual(
      expect.objectContaining({ name: 'draw:render' }),
    )
    expect(appState.plugins.commands).toContainEqual(
      expect.objectContaining({ name: 'draw:paint' }),
    )
  })
})

describe('Plugins catalog & install API', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-plugins-catalog-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    clearInstalledPluginsCache()
    clearPluginCache('plugins-catalog-test-setup')
    resetSettingsCache()
    __resetWebSocketHandlerStateForTests()
  })

  afterEach(async () => {
    __resetWebSocketHandlerStateForTests()
    clearInstalledPluginsCache()
    clearPluginCache('plugins-catalog-test-teardown')
    resetSettingsCache()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('GET /api/plugins/catalog returns the curated entries with installed=false on a clean config', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/plugins/catalog')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      catalog: Array<{
        id: string
        marketplace: string
        installed: boolean
        category: string
      }>
    }

    expect(body.catalog.length).toBeGreaterThan(0)
    const sp = body.catalog.find((e) => e.id === 'superpowers')
    expect(sp).toBeDefined()
    expect(sp?.marketplace).toBe('claude-plugins-official')
    expect(sp?.installed).toBe(false)
  })

  it('GET /api/plugins/catalog includes the cc-haha-builtin plugins (media-gen, reverse-engineering)', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/plugins/catalog')
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      catalog: Array<{ id: string; marketplace: string; installed: boolean }>
    }

    const imageGen = body.catalog.find((e) => e.id === 'media-gen')
    expect(imageGen).toBeDefined()
    expect(imageGen?.marketplace).toBe('cc-haha-builtin')
    expect(imageGen?.installed).toBe(false)

    const re = body.catalog.find((e) => e.id === 'reverse-engineering')
    expect(re).toBeDefined()
    expect(re?.marketplace).toBe('cc-haha-builtin')
    expect(re?.installed).toBe(false)
  })

  it('POST /api/plugins/install rejects cc-haha-builtin entries when the seed marketplace has not been registered', async () => {
    // Clean config = no known_marketplaces.json entry for cc-haha-builtin.
    // The catalog entry has no marketplaceSource, so the install path must
    // refuse with a clear message instead of trying to clone a placeholder.
    const { req, url, segments } = makeRequest('POST', '/api/plugins/install', {
      id: 'media-gen',
      marketplace: 'cc-haha-builtin',
    })
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { message: string }
    expect(body.message).toMatch(/cc-haha-builtin/)
    expect(body.message).toMatch(/not registered|seed/i)
  })

  it('POST /api/plugins/marketplace registers a local directory marketplace from input', async () => {
    const marketplaceRoot = path.join(tmpDir, 'local-market')
    await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await fs.writeFile(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'my-local-mkt',
        owner: { name: 'Tester' },
        plugins: [],
      }),
      'utf-8',
    )

    const { req, url, segments } = makeRequest('POST', '/api/plugins/marketplace', {
      input: marketplaceRoot,
    })
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: true
      name: string
      alreadyMaterialized: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.name).toBe('my-local-mkt')
    expect(body.alreadyMaterialized).toBe(false)

    // Idempotent re-add: same source returns alreadyMaterialized.
    const second = makeRequest('POST', '/api/plugins/marketplace', {
      input: marketplaceRoot,
    })
    const secondRes = await handlePluginsApi(second.req, second.url, second.segments)
    const secondBody = (await secondRes.json()) as { alreadyMaterialized: boolean }
    expect(secondBody.alreadyMaterialized).toBe(true)
  })

  it('POST /api/plugins/marketplace rejects invalid input', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/marketplace', {
      input: 'this is not a valid source spec',
    })
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(400)
  })

  it('POST /api/plugins/install enables a catalog plugin and flips installed in catalog', async () => {
    // Pre-materialize the official marketplace from a fake local directory so
    // addMarketplaceSource short-circuits (source-idempotent) and we never
    // touch the network. We register it under the official name with the
    // exact OFFICIAL_MARKETPLACE_SOURCE shape the catalog uses.
    const marketplaceRoot = path.join(tmpDir, 'fake-official')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'superpowers')
    const pluginsDir = path.join(tmpDir, 'plugins')

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'superpowers', version: '0.0.0', description: 'test' }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'claude-plugins-official',
        owner: { name: 'Anthropic' },
        plugins: [
          { name: 'superpowers', source: './plugins/superpowers', version: '0.0.0' },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'claude-plugins-official': {
          source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    // Sanity: catalog reports installed=false initially.
    const before = makeRequest('GET', '/api/plugins/catalog')
    const beforeBody = (await (await handlePluginsApi(
      before.req,
      before.url,
      before.segments,
    )).json()) as { catalog: Array<{ id: string; installed: boolean }> }
    expect(
      beforeBody.catalog.find((e) => e.id === 'superpowers')?.installed,
    ).toBe(false)

    // Install — addMarketplaceSource is source-idempotent (source matches
    // pre-registered entry), so this only writes settings + V2 file.
    const inst = makeRequest('POST', '/api/plugins/install', {
      id: 'superpowers',
      marketplace: 'claude-plugins-official',
    })
    const instRes = await handlePluginsApi(inst.req, inst.url, inst.segments)
    expect(instRes.status).toBe(200)
    const instBody = (await instRes.json()) as {
      ok: true
      marketplaceAdded: boolean
    }
    expect(instBody.ok).toBe(true)
    expect(instBody.marketplaceAdded).toBe(false) // already materialized

    // settings.json should now have the enabled entry.
    const settings = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'),
    ) as { enabledPlugins: Record<string, unknown> }
    expect(settings.enabledPlugins['superpowers@claude-plugins-official']).toBe(true)

    // Catalog now reports installed=true (V2 installed file populated by enable).
    const after = makeRequest('GET', '/api/plugins/catalog')
    const afterBody = (await (await handlePluginsApi(
      after.req,
      after.url,
      after.segments,
    )).json()) as { catalog: Array<{ id: string; installed: boolean }> }
    expect(
      afterBody.catalog.find((e) => e.id === 'superpowers')?.installed,
    ).toBe(true)
  })

  it('POST /api/plugins/install migrates image-gen settings to media-gen', async () => {
    const marketplaceRoot = path.join(tmpDir, 'builtin-marketplace')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'media-gen')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const oldPluginId = 'image-gen@cc-haha-builtin'
    const newPluginId = 'media-gen@cc-haha-builtin'

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'media-gen', version: '0.0.0', description: 'test' }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'cc-haha-builtin',
        owner: { name: 'cc-haha' },
        plugins: [
          { name: 'media-gen', source: './plugins/media-gen', version: '0.0.0' },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'cc-haha-builtin': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: { [oldPluginId]: true, [newPluginId]: false },
        pluginConfigs: {
          [oldPluginId]: {
            options: { outputDirectory: '/legacy-fake-output', apiToken: 'legacy-fake-token' },
          },
          [newPluginId]: {
            options: { outputDirectory: '/new-fake-output', apiToken: 'new-fake-token' },
          },
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          [oldPluginId]: [
            {
              scope: 'user',
              installPath: path.join(tmpDir, 'legacy-image-gen'),
              version: '1.2.3',
              installedAt: '2024-01-02T03:04:05.000Z',
              lastUpdated: '2024-06-07T08:09:10.000Z',
            },
          ],
        },
      }),
      'utf-8',
    )
    clearInstalledPluginsCache()
    resetSettingsCache()

    const install = makeRequest('POST', '/api/plugins/install', {
      id: 'media-gen',
      marketplace: 'cc-haha-builtin',
    })
    const response = await handlePluginsApi(install.req, install.url, install.segments)
    expect(response.status).toBe(200)

    const settings = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'),
    ) as {
      enabledPlugins: Record<string, unknown>
      pluginConfigs: Record<string, unknown>
    }
    expect(settings.enabledPlugins).toEqual({ [newPluginId]: false })
    expect(settings.pluginConfigs).toEqual({
      [newPluginId]: {
        options: { outputDirectory: '/new-fake-output', apiToken: 'new-fake-token' },
      },
    })
    const registry = JSON.parse(
      await fs.readFile(path.join(pluginsDir, 'installed_plugins.json'), 'utf-8'),
    ) as { plugins: Record<string, unknown> }
    expect(registry.plugins[oldPluginId]).toBeUndefined()
    expect(registry.plugins[newPluginId]).toBeDefined()
  })

  it('POST /api/plugins/install restores media-gen migration settings and registry when installation fails', async () => {
    const marketplaceRoot = path.join(tmpDir, 'builtin-marketplace')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'media-gen')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const oldPluginId = 'image-gen@cc-haha-builtin'
    const newPluginId = 'media-gen@cc-haha-builtin'

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      '{ invalid json',
      'utf-8',
    )
    await fs.writeFile(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'cc-haha-builtin',
        owner: { name: 'cc-haha' },
        plugins: [
          { name: 'media-gen', source: './plugins/media-gen', version: '0.0.0' },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'cc-haha-builtin': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    const settingsSnapshot = {
      enabledPlugins: { [oldPluginId]: false, 'unrelated@test': true },
      pluginConfigs: {
        [oldPluginId]: { options: { apiToken: 'rollback-fake-token' } },
        'unrelated@test': { options: { keep: false } },
      },
      customSetting: 'preserve-me',
    }
    const registrySnapshot = {
      version: 2,
      plugins: {
        [oldPluginId]: [
          {
            scope: 'user',
            installPath: path.join(tmpDir, 'legacy-image-gen'),
            version: '1.2.3',
            installedAt: '2024-01-02T03:04:05.000Z',
            lastUpdated: '2024-06-07T08:09:10.000Z',
          },
        ],
        'unrelated@test': [
          {
            scope: 'project',
            projectPath: path.join(tmpDir, 'project'),
            installPath: path.join(tmpDir, 'unrelated'),
            version: '9.9.9',
            installedAt: '2023-01-02T03:04:05.000Z',
            lastUpdated: '2023-06-07T08:09:10.000Z',
          },
        ],
      },
    }
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify(settingsSnapshot),
      'utf-8',
    )
    const registryPath = path.join(pluginsDir, 'installed_plugins.json')
    await fs.writeFile(registryPath, JSON.stringify(registrySnapshot), 'utf-8')
    clearInstalledPluginsCache()
    resetSettingsCache()

    const install = makeRequest('POST', '/api/plugins/install', {
      id: 'media-gen',
      marketplace: 'cc-haha-builtin',
    })
    const response = await handlePluginsApi(install.req, install.url, install.segments)

    expect(response.status).toBe(400)
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'))).toEqual(
      settingsSnapshot,
    )
    expect(JSON.parse(await fs.readFile(registryPath, 'utf-8'))).toEqual(
      registrySnapshot,
    )
  })

  it('POST /api/plugins/install rejects unknown catalog entries', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/install', {
      id: 'does-not-exist',
      marketplace: 'claude-plugins-official',
    })
    const res = await handlePluginsApi(req, url, segments)
    expect(res.status).toBe(404)
  })
})

describe('Media-gen provider config API', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-media-gen-api-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetSettingsCache()
  })

  afterEach(async () => {
    resetSettingsCache()
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('GET returns schema v2 providers with key status and never returns secrets', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({
      pluginConfigs: { 'media-gen@cc-haha-builtin': { options: { mediaProviderConfig: JSON.stringify({
        schemaVersion: 3,
        providers: [{ id: 'stable-id', name: 'Local', enabled: false, apiFormat: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1', models: { imageGeneration: 'flux' } }],
      }) } } },
    }))
    await fs.writeFile(path.join(tmpDir, '.credentials.json'), JSON.stringify({
      pluginSecrets: { 'media-gen@cc-haha-builtin': { mediaProviderApiKeys: JSON.stringify({ 'stable-id': 'super-secret' }) } },
    }))

    const request = makeRequest('GET', '/api/plugins/media-gen/config')
    const response = await handlePluginsApi(request.req, request.url, request.segments)
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toEqual({ schemaVersion: 3, providers: [{
      id: 'stable-id', name: 'Local', enabled: false, apiFormat: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1',
      models: { imageGeneration: 'flux' },
      apiKeyConfigured: true,
    }] })
    expect(JSON.stringify(body)).not.toContain('super-secret')
  })

  it('GET migrates legacy media-gen and renamed image-gen P1-P3 options while preferring v2', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ pluginConfigs: {
      'image-gen@cc-haha-builtin': { options: { PROVIDER_1_NAME: 'Old', PROVIDER_1_BASE_URL: 'https://old.example/v1', PROVIDER_1_MODEL: 'old-model' } },
      'media-gen@cc-haha-builtin': { options: { PROVIDER_2_NAME: 'New', PROVIDER_2_BASE_URL: 'https://new.example/v1', PROVIDER_2_MODEL: 'new-model' } },
    } }))
    await fs.writeFile(path.join(tmpDir, '.credentials.json'), JSON.stringify({ pluginSecrets: {
      'image-gen@cc-haha-builtin': { PROVIDER_1_API_KEY: 'old-secret' },
      'media-gen@cc-haha-builtin': { PROVIDER_2_API_KEY: 'new-secret' },
    } }))

    const request = makeRequest('GET', '/api/plugins/media-gen/config')
    const body = await (await handlePluginsApi(request.req, request.url, request.segments)).json() as {
      providers: Array<{ name: string; enabled: boolean; apiFormat: string; models: { imageGeneration?: string }; apiKeyConfigured: boolean }>
    }
    expect(body.providers.map(p => p.name)).toEqual(['Old', 'New'])
    expect(body.providers[0]?.models.imageGeneration).toBe('old-model')
    expect(body.providers[0]?.enabled).toBe(true)
    expect(body.providers[0]?.apiFormat).toBe('openai_compatible')
    expect(body.providers.every(p => p.apiKeyConfigured)).toBe(true)

    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'))
    expect(JSON.parse(saved.pluginConfigs['media-gen@cc-haha-builtin'].options.mediaProviderConfig).schemaVersion).toBe(3)
    const credentials = JSON.parse(await fs.readFile(path.join(tmpDir, '.credentials.json'), 'utf-8')) as {
      pluginSecrets: Record<string, Record<string, string>>
    }
    expect(credentials.pluginSecrets['image-gen@cc-haha-builtin']?.PROVIDER_1_API_KEY).toBeUndefined()
    expect(credentials.pluginSecrets['media-gen@cc-haha-builtin']?.PROVIDER_2_API_KEY).toBeUndefined()
  })

  it('GET rolls back settings and secrets when legacy secret cleanup fails, then retries migration', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({ pluginConfigs: {
      'image-gen@cc-haha-builtin': { options: { PROVIDER_1_NAME: 'Old', PROVIDER_1_BASE_URL: 'https://old.example/v1' } },
    } }))
    await fs.writeFile(path.join(tmpDir, '.credentials.json'), JSON.stringify({ pluginSecrets: {
      'image-gen@cc-haha-builtin': { PROVIDER_1_API_KEY: 'old-secret' },
    } }))

    const originalUpdate = plainTextStorage.update
    let updateCount = 0
    plainTextStorage.update = data => {
      updateCount++
      if (updateCount === 2) return { success: false }
      return originalUpdate(data)
    }
    try {
      const first = makeRequest('GET', '/api/plugins/media-gen/config')
      expect((await handlePluginsApi(first.req, first.url, first.segments)).status).toBe(500)
    } finally {
      plainTextStorage.update = originalUpdate
    }

    const afterFailure = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf-8'))
    expect(afterFailure.pluginConfigs['media-gen@cc-haha-builtin']?.options?.mediaProviderConfig).toBeUndefined()
    const second = makeRequest('GET', '/api/plugins/media-gen/config')
    const response = await handlePluginsApi(second.req, second.url, second.segments)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ providers: [{ name: 'Old', apiKeyConfigured: true }] })
  })

  it('GET fails closed when stored schema v2 JSON is damaged', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), JSON.stringify({
      pluginConfigs: { 'media-gen@cc-haha-builtin': { options: { mediaProviderConfig: '{broken' } } },
    }))
    const request = makeRequest('GET', '/api/plugins/media-gen/config')
    expect((await handlePluginsApi(request.req, request.url, request.segments)).status).toBe(500)
  })

  it('POST fetch-models fetches an unsaved draft with its current URL and replacement key', async () => {
    const originalFetch = globalThis.fetch
    let upstreamUrl = ''
    let authorization = ''
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      upstreamUrl = String(url)
      authorization = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response(JSON.stringify({ data: [{ id: 'flux' }] }), { status: 200 })
    }) as typeof fetch
    try {
      const request = makeRequest('POST', '/api/plugins/media-gen/fetch-models', {
        providerId: 'new-draft',
        baseUrl: 'http://127.0.0.1:8080/draft',
        apiFormat: 'openai_compatible',
        apiKey: { action: 'replace', value: 'draft-secret' },
      })
      const response = await handlePluginsApi(request.req, request.url, request.segments)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: [{ id: 'flux' }] })
      expect(upstreamUrl).toBe('http://127.0.0.1:8080/draft/v1/models')
      expect(authorization).toBe('Bearer draft-secret')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('PUT rejects keeping an existing key after the provider origin changes', async () => {
    const initial = makeRequest('PUT', '/api/plugins/media-gen/config', { schemaVersion: 3, providers: [{
      id: 'saved', name: 'Saved', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://old.example/v1', models: { imageGeneration: 'image-model' },
      apiKey: { action: 'replace', value: 'saved-secret' },
    }] })
    expect((await handlePluginsApi(initial.req, initial.url, initial.segments)).status).toBe(200)

    const changed = makeRequest('PUT', '/api/plugins/media-gen/config', { schemaVersion: 3, providers: [{
      id: 'saved', name: 'Saved', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://attacker.example/v1', models: { imageGeneration: 'image-model' },
      apiKey: { action: 'keep' },
    }] })
    const response = await handlePluginsApi(changed.req, changed.url, changed.segments)

    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/origin changed|re-enter/i)
    const getConfig = makeRequest('GET', '/api/plugins/media-gen/config')
    const stored = await (await handlePluginsApi(getConfig.req, getConfig.url, getConfig.segments)).json() as { providers: Array<{ baseUrl: string; apiKeyConfigured: boolean }> }
    expect(stored.providers).toEqual([expect.objectContaining({ baseUrl: 'https://old.example/v1', apiKeyConfigured: true })])
  })

  it('POST fetch-models keeps the saved key only for the saved provider origin', async () => {
    const config = makeRequest('PUT', '/api/plugins/media-gen/config', { schemaVersion: 3, providers: [{
      id: 'saved', name: 'Saved', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://old.example', models: {},
      apiKey: { action: 'replace', value: 'saved-secret' },
    }] })
    expect((await handlePluginsApi(config.req, config.url, config.segments)).status).toBe(200)
    const originalFetch = globalThis.fetch
    let requestDetails: { url?: string; authorization?: string } = {}
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requestDetails = { url: String(url), authorization: new Headers(init?.headers).get('Authorization') ?? '' }
      return new Response(JSON.stringify({ models: [{ id: 'draft-model' }] }), { status: 200 })
    }) as typeof fetch
    try {
      const request = makeRequest('POST', '/api/plugins/media-gen/fetch-models', {
        providerId: 'saved', baseUrl: 'https://OLD.example:443/v1', apiFormat: 'openai_compatible', apiKey: { action: 'keep' },
      })
      const response = await handlePluginsApi(request.req, request.url, request.segments)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ models: [{ id: 'draft-model' }] })
      expect(requestDetails).toEqual({ url: 'https://OLD.example:443/v1/models', authorization: 'Bearer saved-secret' })

      requestDetails = {}
      const crossOrigin = makeRequest('POST', '/api/plugins/media-gen/fetch-models', {
        providerId: 'saved', baseUrl: 'https://draft.example/v1', apiFormat: 'openai_compatible', apiKey: { action: 'keep' },
      })
      const rejected = await handlePluginsApi(crossOrigin.req, crossOrigin.url, crossOrigin.segments)
      expect(rejected.status).toBe(400)
      expect(await rejected.text()).toMatch(/re-enter|重新输入/i)
      expect(requestDetails).toEqual({})

      const unknown = makeRequest('POST', '/api/plugins/media-gen/fetch-models', {
        providerId: 'new-draft', baseUrl: 'https://old.example', apiFormat: 'openai_compatible', apiKey: { action: 'keep' },
      })
      expect((await handlePluginsApi(unknown.req, unknown.url, unknown.segments)).status).toBe(400)
      expect(requestDetails).toEqual({})
    } finally { globalThis.fetch = originalFetch }
  })

  it('POST fetch-models replacement key overrides storage and clear never falls back', async () => {
    const config = makeRequest('PUT', '/api/plugins/media-gen/config', { schemaVersion: 3, providers: [{
      id: 'saved', name: 'Saved', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://old.example', models: {},
      apiKey: { action: 'replace', value: 'old-secret' },
    }] })
    await handlePluginsApi(config.req, config.url, config.segments)
    const originalFetch = globalThis.fetch
    let authorization = ''
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response(JSON.stringify([{ id: 'model' }]), { status: 200 })
    }) as typeof fetch
    try {
      const replace = makeRequest('POST', '/api/plugins/media-gen/fetch-models', {
        providerId: 'saved', baseUrl: 'https://draft.example', apiFormat: 'openai_compatible', apiKey: { action: 'replace', value: 'new-secret' },
      })
      expect((await handlePluginsApi(replace.req, replace.url, replace.segments)).status).toBe(200)
      expect(authorization).toBe('Bearer new-secret')
      const clear = makeRequest('POST', '/api/plugins/media-gen/fetch-models', {
        providerId: 'saved', baseUrl: 'https://draft.example', apiFormat: 'openai_compatible', apiKey: { action: 'clear' },
      })
      expect((await handlePluginsApi(clear.req, clear.url, clear.segments)).status).toBe(400)
    } finally { globalThis.fetch = originalFetch }
  })

  it('POST fetch-models rejects extra fields, nested secret fields, and non-http URLs', async () => {
    const valid = { providerId: 'draft', baseUrl: 'https://draft.example', apiFormat: 'openai_compatible', apiKey: { action: 'replace', value: 'secret' } }
    for (const body of [
      { ...valid, secret: 'leak' },
      { ...valid, apiKey: { action: 'replace', value: 'secret', token: 'leak' } },
      { ...valid, apiKey: { action: 'keep', value: 'leak' } },
      { ...valid, apiKey: { action: 'clear', value: 'leak' } },
      { ...valid, apiKey: { action: 'replace', value: '' } },
      { ...valid, baseUrl: 'file:///tmp/models' },
    ]) {
      const request = makeRequest('POST', '/api/plugins/media-gen/fetch-models', body)
      expect((await handlePluginsApi(request.req, request.url, request.segments)).status).toBe(400)
    }
  })

  it('PUT accepts an unnamed partial provider with one model and GET does not expose its key', async () => {
    const put = makeRequest('PUT', '/api/plugins/media-gen/config', { schemaVersion: 3, providers: [{
      id: 'unnamed', name: '', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://example.com/v1',
      models: { imageGeneration: 'image-model' }, apiKey: { action: 'replace', value: 'private-key' },
    }] })
    expect((await handlePluginsApi(put.req, put.url, put.segments)).status).toBe(200)

    const get = makeRequest('GET', '/api/plugins/media-gen/config')
    const response = await handlePluginsApi(get.req, get.url, get.segments)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toEqual({ schemaVersion: 3, providers: [{
      id: 'unnamed', name: '', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://example.com/v1',
      models: { imageGeneration: 'image-model' }, apiKeyConfigured: true,
    }] })
    expect(JSON.stringify(body)).not.toContain('private-key')
  })

  it('PUT validates providers and supports API key replace, keep, clear, and deletion cleanup', async () => {
    const put = async (providers: unknown[]) => {
      const request = makeRequest('PUT', '/api/plugins/media-gen/config', { schemaVersion: 3, providers })
      return handlePluginsApi(request.req, request.url, request.segments)
    }
    const provider = { id: 'provider-one', name: 'One', enabled: false, apiFormat: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1', models: { imageGeneration: 'flux' } }
    expect((await put([{ ...provider, apiKey: { action: 'replace', value: 'secret-one' } }])).status).toBe(200)
    expect((await put([{ ...provider, name: 'Renamed', apiKey: { action: 'keep' } }])).status).toBe(200)
    let credentials = JSON.parse(await fs.readFile(path.join(tmpDir, '.credentials.json'), 'utf-8'))
    expect(JSON.parse(credentials.pluginSecrets['media-gen@cc-haha-builtin'].mediaProviderApiKeys)).toEqual({ 'provider-one': 'secret-one' })

    expect((await put([{ ...provider, apiKey: { action: 'clear' } }])).status).toBe(200)
    credentials = JSON.parse(await fs.readFile(path.join(tmpDir, '.credentials.json'), 'utf-8'))
    expect(JSON.parse(credentials.pluginSecrets['media-gen@cc-haha-builtin'].mediaProviderApiKeys)).toEqual({})

    expect((await put([{ ...provider, apiKey: { action: 'replace', value: 'again' } }])).status).toBe(200)
    expect((await put([])).status).toBe(200)
    credentials = JSON.parse(await fs.readFile(path.join(tmpDir, '.credentials.json'), 'utf-8'))
    expect(JSON.parse(credentials.pluginSecrets['media-gen@cc-haha-builtin'].mediaProviderApiKeys)).toEqual({})

    expect((await put(Array.from({ length: 17 }, (_, i) => ({ ...provider, id: `p-${i}` })))).status).toBe(400)
    expect((await put([provider, provider])).status).toBe(400)
    expect((await put([{ ...provider, models: { unsupported: 'x' } }])).status).toBe(400)
    expect((await put([{ ...provider, models: { imageGeneration: ['flux'] } }])).status).toBe(400)
    expect((await put([{ ...provider, baseUrl: 'file:///tmp/models' }])).status).toBe(400)
    expect((await put([{ ...provider, baseUrl: 'not a URL' }])).status).toBe(400)
  })

  it('PUT enforces per-key and serialized API key UTF-8 byte limits', async () => {
    const put = async (providers: unknown[]) => {
      const request = makeRequest('PUT', '/api/plugins/media-gen/config', { schemaVersion: 3, providers })
      return handlePluginsApi(request.req, request.url, request.segments)
    }
    const provider = { name: 'One', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://example.com/v1', models: {} }
    expect((await put([{ ...provider, id: 'boundary', apiKey: { action: 'replace', value: '四'.repeat(5461) + 'a' } }])).status).toBe(200)
    expect((await put([{ ...provider, id: 'too-large', apiKey: { action: 'replace', value: '四'.repeat(5462) } }])).status).toBe(400)
    const maximumKeys = Array.from({ length: 16 }, (_, index) => ({
      ...provider,
      id: `provider-${index}`,
      apiKey: { action: 'replace', value: 'x'.repeat(16 * 1024) },
    }))
    expect((await put(maximumKeys)).status).toBe(400)
  })
})

describe('Language servers API', () => {
  it('GET /api/plugins/language-servers returns status for every known language', async () => {
    const { req, url, segments } = makeRequest(
      'GET',
      '/api/plugins/language-servers',
    )
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      servers: Array<{
        language: string
        label: string
        installed: boolean
        resolvedPath: string | null
        install: Record<string, unknown>
      }>
    }

    const ids = body.servers.map((s) => s.language).sort()
    expect(ids).toEqual(
      ['c', 'cpp', 'csharp', 'go', 'java', 'lua', 'php', 'python', 'rust', 'typescript'].sort(),
    )
    for (const server of body.servers) {
      expect(typeof server.installed).toBe('boolean')
      expect(typeof server.label).toBe('string')
    }
  })
})

