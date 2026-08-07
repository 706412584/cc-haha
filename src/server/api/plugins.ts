import type { PluginScope } from '../../utils/plugins/schemas.js'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { PluginService } from '../services/pluginService.js'
import {
  clearKnownLanguageServerCache,
  getKnownLanguageServerStatuses,
} from '../services/knownLanguageServers.js'
import {
  loadPluginOptions,
  savePluginOptions,
  clearPluginOptionsCache,
} from '../../utils/plugins/pluginOptionsStorage.js'
import type { PluginManifest } from '../../utils/plugins/schemas.js'
import { getMediaGenConfig, getMediaGenProviderCredentials, saveMediaGenConfig } from '../services/mediaGenConfigService.js'
import { ProviderService } from '../services/providerService.js'
import { reloadSessionComponents } from '../services/sessionComponentReloadService.js'

const pluginService = new PluginService()
const providerService = new ProviderService()

export async function handlePluginsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const sub = segments[2]
    const cwd = url.searchParams.get('cwd') || undefined

    if (method === 'GET' && !sub) {
      return Response.json(await pluginService.listPlugins(cwd))
    }

    if (sub === 'media-gen' && segments[3] === 'config') {
      if (method === 'GET') return Response.json(getMediaGenConfig())
      if (method === 'PUT') return Response.json(await saveMediaGenConfig(await parseJsonBody(req)))
    }
    if (method === 'GET' && sub === 'media-gen' && segments[3] === 'provider-choices') {
      const { providers } = await providerService.listProviders()
      return Response.json({ providers: providers.map(provider => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        credentialConfigured: Boolean(provider.apiKey),
        compatible: Boolean(provider.apiKey) && (provider.apiFormat === 'openai_chat' || provider.apiFormat === 'openai_responses'),
      })) })
    }
    if (method === 'POST' && sub === 'media-gen' && segments[3] === 'fetch-models') {
      const body = await parseJsonBody(req)
      const allowed = new Set(['providerId', 'baseUrl', 'apiFormat', 'apiKey'])
      if (Object.keys(body).some(key => !allowed.has(key))) throw ApiError.badRequest('Unexpected fetch-models field')
      const providerId = asString(body.providerId)
      const baseUrl = asString(body.baseUrl)
      const apiKey = body.apiKey
      if (!providerId || !baseUrl || body.apiFormat !== 'openai_compatible' || !apiKey || typeof apiKey !== 'object' || Array.isArray(apiKey)) throw ApiError.badRequest('Invalid fetch-models request')
      const key = apiKey as Record<string, unknown>
      const validApiKey = key.action === 'keep' || key.action === 'clear'
        ? Object.keys(key).length === 1
        : key.action === 'replace' && typeof key.value === 'string' && key.value.length > 0 && Object.keys(key).length === 2 && Object.hasOwn(key, 'value')
          || key.action === 'reference' && Object.keys(key).length === 2 && key.credentialRef && typeof key.credentialRef === 'object'
      if (!validApiKey) throw ApiError.badRequest('Invalid API key action')
      const input = await getMediaGenProviderCredentials({ providerId, baseUrl, apiFormat: 'openai_compatible', apiKey: key as never })
      const result = await providerService.fetchUpstreamModels(input)
      return Response.json(result.data)
    }

    if (method === 'GET' && sub === 'catalog') {
      return Response.json({
        catalog: await pluginService.getCatalog(),
      })
    }

    if (method === 'GET' && sub === 'detail') {
      const pluginId = url.searchParams.get('id')
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" query parameter')
      }
      return Response.json({
        detail: await pluginService.getPluginDetail(pluginId, cwd),
      })
    }

    if (method === 'GET' && sub === 'prerequisites') {
      const pluginId = url.searchParams.get('id')
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" query parameter')
      }
      return Response.json(
        await pluginService.checkPluginPrerequisites(pluginId, cwd),
      )
    }

    if (method === 'GET' && sub === 'options') {
      const pluginId = url.searchParams.get('id')
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" query parameter')
      }
      const detail = await pluginService.getPluginDetail(pluginId, cwd)
      const userConfig = (detail as Record<string, unknown>).userConfig as PluginManifest['userConfig'] | undefined
      const options = loadPluginOptions(pluginId)
      // Mask sensitive values — frontend only needs to know they exist
      const masked: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(options)) {
        if (userConfig?.[key]?.sensitive === true) {
          masked[key] = typeof value === 'string' && value.length > 0 ? '********' : ''
        } else {
          masked[key] = value
        }
      }
      return Response.json({
        pluginId,
        schema: userConfig ?? {},
        values: masked,
      })
    }

    if (method === 'POST' && sub === 'options') {
      const body = await parseJsonBody(req)
      const pluginId = asString(body.id)
      if (!pluginId) {
        throw ApiError.badRequest('Missing required "id" field')
      }
      const values = body.values as Record<string, unknown> | undefined
      if (!values || typeof values !== 'object') {
        throw ApiError.badRequest('Missing required "values" field')
      }
      const detail = await pluginService.getPluginDetail(pluginId, cwd)
      const userConfig = (detail as Record<string, unknown>).userConfig as PluginManifest['userConfig'] | undefined
      if (!userConfig || Object.keys(userConfig).length === 0) {
        throw ApiError.badRequest('Plugin has no userConfig options')
      }
      // Filter to only schema-declared keys (prevent injection of arbitrary keys)
      const filtered: Record<string, unknown> = {}
      for (const key of Object.keys(userConfig)) {
        if (key in values) {
          filtered[key] = values[key]
        }
      }
      savePluginOptions(pluginId, filtered, userConfig)
      clearPluginOptionsCache()
      return Response.json({ ok: true, pluginId })
    }

    if (method === 'GET' && sub === 'language-servers') {
      if (url.searchParams.get('refresh')) {
        clearKnownLanguageServerCache()
      }
      return Response.json({
        servers: await getKnownLanguageServerStatuses(),
      })
    }

    if (method === 'POST' && sub === 'reload') {
      const sessionId = url.searchParams.get('sessionId') || undefined
      const response = await pluginService.reloadPlugins(cwd)
      if (!sessionId) {
        return Response.json(response)
      }

      return Response.json({
        ...response,
        session: await reloadSessionComponents(sessionId),
      })
    }

    if (method === 'POST' && sub === 'install') {
      const body = await parseJsonBody(req)
      const id = asString(body.id)
      const marketplace = asString(body.marketplace)
      if (!id || !marketplace) {
        throw ApiError.badRequest(
          'Missing required fields: "id" and "marketplace"',
        )
      }
      return Response.json(
        await pluginService.installCatalogPlugin(id, marketplace),
      )
    }

    if (method === 'POST' && sub === 'marketplace') {
      const body = await parseJsonBody(req)
      const input = asString(body.input)
      if (!input) {
        throw ApiError.badRequest('Missing required field: "input"')
      }
      return Response.json(await pluginService.addMarketplaceFromInput(input))
    }

    if (method === 'POST' && sub) {
      const body = await parseJsonBody(req)
      const pluginId = asString(body.id)
      if (!pluginId) {
        throw ApiError.badRequest('Missing or invalid "id" in request body')
      }

      assertAllowedBodyKeys(
        body,
        sub === 'uninstall'
          ? ['id', 'scope', 'keepData', 'cwd']
          : ['id', 'scope', 'cwd'],
      )
      const cwd = coerceProjectRoot(body.cwd)

      switch (sub) {
        case 'enable': {
          const scope = coerceScope(body.scope, false)
          return Response.json(await pluginService.enablePlugin(pluginId, scope, cwd))
        }
        case 'disable': {
          const scope = coerceScope(body.scope, false)
          return Response.json(await pluginService.disablePlugin(pluginId, scope, cwd))
        }
        case 'update': {
          const scope = coerceScope(body.scope, true)
          return Response.json(
            await pluginService.updatePlugin(pluginId, scope as PluginScope | undefined, cwd),
          )
        }
        case 'uninstall': {
          const scope = coerceScope(body.scope, false)
          if ('keepData' in body && typeof body.keepData !== 'boolean') {
            throw ApiError.badRequest('"keepData" must be a boolean')
          }
          return Response.json(
            await pluginService.uninstallPlugin(
              pluginId,
              scope,
              body.keepData === true,
              cwd,
            ),
          )
        }
        default:
          throw ApiError.notFound(`Unknown plugins endpoint: ${sub}`)
      }
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/plugins${sub ? `/${sub}` : ''}`,
      'METHOD_NOT_ALLOWED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json() as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw ApiError.badRequest('JSON body must be an object')
    }
    return body as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 512
    ? normalized
    : undefined
}

function coerceScope(value: unknown, allowManaged: boolean):
  | 'user'
  | 'project'
  | 'local'
  | 'managed'
  | undefined {
  if (value == null) return undefined
  if (
    value === 'user' ||
    value === 'project' ||
    value === 'local' ||
    (allowManaged && value === 'managed')
  ) {
    return value
  }
  throw ApiError.badRequest(
    `Invalid "scope". Expected one of: user, project, local${allowManaged ? ', managed' : ''}`,
  )
}

function coerceProjectRoot(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw ApiError.badRequest('"cwd" must be a non-empty absolute directory path')
  }
  if (!isAbsolute(value)) {
    throw ApiError.badRequest('"cwd" must be an absolute directory path')
  }
  const normalized = resolve(value)
  try {
    if (!statSync(normalized).isDirectory()) {
      throw ApiError.badRequest('"cwd" must reference an existing directory')
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw ApiError.badRequest('"cwd" must reference an existing directory')
  }
  return normalized
}

function assertAllowedBodyKeys(
  body: Record<string, unknown>,
  allowed: string[],
): void {
  const allowedKeys = new Set(allowed)
  const unknownKey = Object.keys(body).find((key) => !allowedKeys.has(key))
  if (unknownKey) {
    throw ApiError.badRequest(`Unknown request field: "${unknownKey}"`)
  }
}
