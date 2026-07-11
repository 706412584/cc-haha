import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { LoadedPlugin } from '../../types/plugin.js'

let providers: Array<{
  id: string
  name: string
  enabled: boolean
  apiFormat: 'openai_compatible'
  baseUrl: string
  models: { imageGeneration: string }
  apiKeyConfigured: boolean
}> = []
const credentialResults = new Map<string, string | Error>()

mock.module('../../server/services/mediaGenConfigService.js', () => ({
  MEDIA_GEN_PLUGIN_ID: 'media-gen@cc-haha-builtin',
  getMediaGenConfig: () => ({ schemaVersion: 3, providers }),
  getMediaGenProviderCredentials: async ({ providerId }: { providerId: string }) => {
    const result = credentialResults.get(providerId)
    if (result instanceof Error) throw result
    return { baseUrl: `https://${providerId}.example/v1`, apiKey: result, apiFormat: 'openai_chat' }
  },
}))

mock.module('./pluginDirectories.js', () => ({
  getPluginDataDir: () => '/plugin-data',
}))

import { extractMcpServersFromPlugins, getPluginMcpServers } from './mcpPluginIntegration.js'

const legacyEnv = {
  MEDIA_GEN_P1_NAME: '${user_config.PROVIDER_1_NAME}',
  MEDIA_GEN_P1_BASE_URL: '${user_config.PROVIDER_1_BASE_URL}',
  MEDIA_GEN_P1_API_KEY: '${user_config.PROVIDER_1_API_KEY}',
  MEDIA_GEN_P1_MODEL: '${user_config.PROVIDER_1_MODEL}',
  MEDIA_GEN_P2_NAME: '${user_config.PROVIDER_2_NAME}',
  MEDIA_GEN_P2_BASE_URL: '${user_config.PROVIDER_2_BASE_URL}',
  MEDIA_GEN_P2_API_KEY: '${user_config.PROVIDER_2_API_KEY}',
  MEDIA_GEN_P2_MODEL: '${user_config.PROVIDER_2_MODEL}',
  MEDIA_GEN_P3_NAME: '${user_config.PROVIDER_3_NAME}',
  MEDIA_GEN_P3_BASE_URL: '${user_config.PROVIDER_3_BASE_URL}',
  MEDIA_GEN_P3_API_KEY: '${user_config.PROVIDER_3_API_KEY}',
  MEDIA_GEN_P3_MODEL: '${user_config.PROVIDER_3_MODEL}',
}

const mediaPlugin = () => {
  const mcpServers = { 'media-gen': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/media-gen-server.mjs'], env: legacyEnv } }
  return {
    name: 'media-gen',
    repository: 'media-gen@cc-haha-builtin',
    source: 'builtin',
    path: '/media-gen',
    enabled: true,
    manifest: {
      userConfig: Object.fromEntries(Object.keys(legacyEnv).map(key => [key.replace('MEDIA_GEN_P', 'PROVIDER_'), { type: 'string', required: true }])),
      mcpServers,
    },
    mcpServers,
  } as unknown as LoadedPlugin
}

const provider = (id: string, enabled = true) => ({
  id,
  name: id,
  enabled,
  apiFormat: 'openai_compatible' as const,
  baseUrl: `https://${id}.example/v1`,
  models: { imageGeneration: 'image-model' },
  apiKeyConfigured: true,
})

beforeEach(() => {
  providers = []
  credentialResults.clear()
})

describe('media-gen MCP runtime environment', () => {
  it('ignores a disabled provider with a stale credential reference', async () => {
    providers = [provider('disabled-stale', false), provider('valid')]
    credentialResults.set('disabled-stale', new Error('Referenced provider is unavailable'))
    credentialResults.set('valid', 'valid-secret')

    const servers = await getPluginMcpServers(mediaPlugin())
    const env = servers?.['plugin:media-gen:media-gen']?.env

    expect(JSON.parse(env?.MEDIA_GEN_PROVIDER_SECRETS_JSON ?? '')).toEqual({ valid: 'valid-secret' })
  })

  it('registers an installed legacy media-gen server through both loading entry points', async () => {
    providers = [provider('valid')]
    credentialResults.set('valid', 'valid-secret')

    const direct = await getPluginMcpServers(mediaPlugin())
    const aggregated = await extractMcpServersFromPlugins([mediaPlugin()])

    for (const servers of [direct, aggregated]) {
      const env = servers?.['plugin:media-gen:media-gen']?.env
      expect(JSON.parse(env?.MEDIA_GEN_PROVIDER_SECRETS_JSON ?? '')).toEqual({ valid: 'valid-secret' })
      expect(env?.MEDIA_GEN_P1_API_KEY).toBeUndefined()
      expect(env?.MEDIA_GEN_P3_MODEL).toBeUndefined()
    }
  })

  it('preserves identical environment variables for non-media-gen plugins', async () => {
    const plugin = {
      ...mediaPlugin(),
      name: 'other',
      repository: 'other@builtin',
      manifest: { mcpServers: { other: { command: 'node', env: { STATIC_VALUE: 'preserved' } } } },
      mcpServers: { other: { command: 'node', env: { STATIC_VALUE: 'preserved' } } },
    } as unknown as LoadedPlugin

    const direct = await getPluginMcpServers(plugin)
    const aggregated = await extractMcpServersFromPlugins([plugin])

    expect(direct?.['plugin:other:other']?.env?.STATIC_VALUE).toBe('preserved')
    expect(aggregated['plugin:other:other']?.env?.STATIC_VALUE).toBe('preserved')
  })

  it('skips one enabled stale credential reference without blocking the MCP server', async () => {
    providers = [provider('enabled-stale'), provider('valid')]
    credentialResults.set('enabled-stale', new Error('Referenced provider is unavailable'))
    credentialResults.set('valid', 'valid-secret')

    const servers = await getPluginMcpServers(mediaPlugin())
    const server = servers?.['plugin:media-gen:media-gen']

    expect(server).toBeDefined()
    expect(JSON.parse(server?.env?.MEDIA_GEN_PROVIDER_SECRETS_JSON ?? '')).toEqual({ valid: 'valid-secret' })
  })
})
