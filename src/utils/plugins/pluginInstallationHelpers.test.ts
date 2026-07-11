import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { clearInstalledPluginsCache } from './installedPluginsManager.js'
import { installResolvedPlugin } from './pluginInstallationHelpers.js'

describe('installResolvedPlugin', () => {
  let tempDir: string
  let originalConfigDir: string | undefined

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-install-rollback-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, '.claude')
    clearInstalledPluginsCache()
    resetSettingsCache()
  })

  afterEach(async () => {
    clearInstalledPluginsCache()
    resetSettingsCache()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('restores the complete registry and enables no closure member when a later dependency fails', async () => {
    const configDir = process.env.CLAUDE_CONFIG_DIR!
    const marketplaceRoot = path.join(tempDir, 'marketplace')
    const pluginsDir = path.join(configDir, 'plugins')
    const marketplaceEntries = [
      { name: 'first-dependency', source: './first-dependency', version: '1.0.0' },
      { name: 'broken-dependency', source: './broken-dependency', version: '1.0.0' },
      {
        name: 'root-plugin',
        source: './root-plugin',
        version: '1.0.0',
        dependencies: ['first-dependency', 'broken-dependency'],
      },
    ]

    for (const entry of marketplaceEntries) {
      const manifestDir = path.join(
        marketplaceRoot,
        entry.name,
        '.claude-plugin',
      )
      await fs.mkdir(manifestDir, { recursive: true })
      await fs.writeFile(
        path.join(manifestDir, 'plugin.json'),
        entry.name === 'broken-dependency'
          ? '{ invalid json'
          : JSON.stringify({ name: entry.name, version: entry.version }),
        'utf-8',
      )
    }
    await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await fs.writeFile(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test-marketplace',
        owner: { name: 'Test' },
        plugins: marketplaceEntries,
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-marketplace': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    const registrySnapshot = {
      version: 2,
      plugins: {
        'existing@test-marketplace': [
          {
            scope: 'user',
            installPath: path.join(tempDir, 'existing-cache'),
            version: '7.8.9',
            installedAt: '2024-01-02T03:04:05.000Z',
            lastUpdated: '2024-06-07T08:09:10.000Z',
            gitCommitSha: 'snapshot-sha',
          },
        ],
      },
    }
    const registryPath = path.join(pluginsDir, 'installed_plugins.json')
    await fs.writeFile(registryPath, JSON.stringify(registrySnapshot), 'utf-8')
    clearInstalledPluginsCache()

    await expect(
      installResolvedPlugin({
        pluginId: 'root-plugin@test-marketplace',
        entry: marketplaceEntries[2]!,
        scope: 'user',
        marketplaceInstallLocation: marketplaceRoot,
      }),
    ).rejects.toThrow()

    expect(JSON.parse(await fs.readFile(registryPath, 'utf-8'))).toEqual(
      registrySnapshot,
    )
    let enabledPlugins: Record<string, unknown> = {}
    try {
      const settings = JSON.parse(
        await fs.readFile(path.join(configDir, 'settings.json'), 'utf-8'),
      ) as { enabledPlugins?: Record<string, unknown> }
      enabledPlugins = settings.enabledPlugins ?? {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    expect(enabledPlugins).not.toHaveProperty('first-dependency@test-marketplace')
    expect(enabledPlugins).not.toHaveProperty('broken-dependency@test-marketplace')
    expect(enabledPlugins).not.toHaveProperty('root-plugin@test-marketplace')
  })

  it('does not leave a plugin enabled when materialization fails', async () => {
    const marketplaceRoot = path.join(tempDir, 'marketplace')
    const pluginRoot = path.join(marketplaceRoot, 'broken-plugin')
    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      '{ invalid json',
      'utf-8',
    )

    await expect(
      installResolvedPlugin({
        pluginId: 'broken-plugin@test-marketplace',
        entry: { name: 'broken-plugin', source: './broken-plugin' },
        scope: 'user',
        marketplaceInstallLocation: marketplaceRoot,
      }),
    ).rejects.toThrow()

    let enabledPlugins: Record<string, unknown> | undefined
    try {
      const settings = JSON.parse(
        await fs.readFile(
          path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
          'utf-8',
        ),
      ) as { enabledPlugins?: Record<string, unknown> }
      enabledPlugins = settings.enabledPlugins
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    expect(enabledPlugins?.['broken-plugin@test-marketplace']).toBeUndefined()
  })
})
