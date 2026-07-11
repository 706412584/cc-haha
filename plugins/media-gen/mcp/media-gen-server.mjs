#!/usr/bin/env node

/**
 * media-gen MCP Server
 *
 * Multi-provider image generation with automatic fallback.
 * Supports any OpenAI-compatible /v1/images/generations endpoint.
 * Zero external dependencies — uses Node.js built-in fetch + raw JSON-RPC over stdio.
 *
 * Compatible providers: Agnes, GPT-image-2, Gemini image, nano-banana, DALL-E,
 * Flux, Stable Diffusion, and any OpenAI-compatible relay (New API / OneAPI style).
 */

import { createInterface } from 'readline'
import { randomUUID } from 'crypto'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { Agent } from 'undici'

// ─── Config ───────────────────────────────────────────────────────────────────

function isUnset(val) {
  return !val || val.trim() === '' || val.startsWith('${user_config.')
}

function expandIpv6(address) {
  const h = address.toLowerCase()
  const [leftRaw, rightRaw] = h.split('::')
  if (h.split('::').length > 2) return null
  const left = leftRaw ? leftRaw.split(':') : []
  const right = rightRaw ? rightRaw.split(':') : []
  if (right.at(-1)?.includes('.')) {
    const octets = right.pop().split('.').map(Number)
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    right.push(((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16))
  }
  const missing = 8 - left.length - right.length
  if ((h.includes('::') && missing < 1) || (!h.includes('::') && missing !== 0)) return null
  const groups = [...left, ...Array(missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  return groups.map((group) => Number.parseInt(group, 16))
}

function ipv4FromMappedIpv6(address) {
  const groups = expandIpv6(address)
  if (!groups || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) return null
  const high = groups[6]
  const low = groups[7]
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

function isPrivateHostname(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const mappedIpv4 = ipv4FromMappedIpv6(h)
  if (mappedIpv4) return isPrivateHostname(mappedIpv4)
  if (
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h.startsWith('127.') ||
    h.startsWith('169.254.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
    /^198\.(1[89])\./.test(h) ||
    /^(22[4-9]|23\d)\./.test(h) ||
    /^24[0-9]\./.test(h) ||
    /^25[0-5]\./.test(h)
  ) return true
  if (
    h === '::' ||
    h === '::1' ||
    h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb') ||
    h.startsWith('fc') || h.startsWith('fd')
  ) return true
  return false
}

async function resolvePublicAddresses(urlString, label) {
  const parsed = new URL(urlString)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label}: 不允许的协议 ${parsed.protocol}。仅支持 http/https。`)
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (isPrivateHostname(hostname)) {
    throw new Error(`${label}: 不允许访问内网地址 ${hostname}`)
  }
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateHostname(address))) {
    throw new Error(`${label}: 域名解析到不允许的内网地址`)
  }
  return { parsed, hostname, addresses }
}

function createPinnedDispatcher(hostname, addresses) {
  const allowed = addresses.map(({ address, family }) => ({ address, family }))
  return new Agent({
    connect: {
      lookup(requestedHostname, options, callback) {
        if (requestedHostname.toLowerCase() !== hostname.toLowerCase()) {
          callback(new Error('DNS hostname changed after validation'))
          return
        }
        if (allowed.length === 0) {
          callback(new Error('No validated address available'))
          return
        }
        if (options?.all) {
          callback(null, allowed)
          return
        }
        callback(null, allowed[0].address, allowed[0].family)
      },
    },
  })
}

function hasSensitiveHeaders(headers) {
  const normalized = new Headers(headers)
  return normalized.has('authorization') || normalized.has('cookie') || normalized.has('proxy-authorization')
}

async function fetchSafeUrl(urlString, init, timeoutMs, label = 'provider_url') {
  let currentUrl = urlString
  const authenticated = hasSensitiveHeaders(init?.headers)
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { parsed, hostname, addresses } = await resolvePublicAddresses(currentUrl, label)
    const dispatcher = createPinnedDispatcher(hostname, addresses)
    const res = await fetchWithTimeout(currentUrl, { ...init, redirect: 'manual', dispatcher }, timeoutMs)
    void dispatcher.close()
    if (![301, 302, 303, 307, 308].includes(res.status)) return res
    const location = res.headers.get('location')
    if (!location) throw new Error(`${label}: 重定向响应缺少 Location`)
    const nextUrl = new URL(location, currentUrl)
    if (parsed.protocol === 'https:' && nextUrl.protocol !== 'https:') {
      throw new Error(`${label}: 不允许 HTTPS 降级重定向`)
    }
    if (authenticated && nextUrl.origin !== parsed.origin) {
      throw new Error(`${label}: 认证请求不允许跨源重定向`)
    }
    currentUrl = nextUrl.href
  }
  throw new Error(`${label}: 重定向次数超过限制`)
}

const MODEL_CAPABILITIES = {
  // Agnes image models
  'agnes-image-2.1-flash': { sizes: ['512x512', '768x768', '1024x1024'], edit: false, transparent: false, maxN: 4, format: 'url' },
  'agnes-image-2.0-flash': { sizes: ['512x512', '768x768', '1024x1024'], edit: false, transparent: false, maxN: 4, format: 'url' },
  // Grok Imagine models
  'grok-imagine-image-quality': { sizes: ['1024x1024'], edit: false, transparent: false, maxN: 1, format: 'url' },
  'grok-imagine-image': { sizes: ['1024x1024'], edit: false, transparent: false, maxN: 1, format: 'url' },
  'grok-imagine-edit': { sizes: ['1024x1024'], edit: true, transparent: false, maxN: 1, format: 'url' },
  // GPT image models
  'gpt-image-2': { sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'], edit: true, transparent: true, maxN: 10, format: 'b64_json', notes: 'size must be multiple of 16, max 3840px' },
  'gpt-image-1': { sizes: ['1024x1024', '1536x1024', '1024x1536', '256x256', '512x512', 'auto'], edit: true, transparent: true, maxN: 10, format: 'b64_json' },
  // DALL-E models
  'dall-e-3': { sizes: ['1024x1024', '1792x1024', '1024x1792'], edit: false, transparent: false, maxN: 1, format: 'url' },
  'dall-e-2': { sizes: ['256x256', '512x512', '1024x1024'], edit: true, transparent: false, maxN: 10, format: 'url' },
  // Gemini image
  'gemini-2.5-flash-image-preview': { sizes: ['1024x1024', '512x512', '1536x1536'], edit: true, transparent: false, maxN: 4, format: 'b64_json' },
  'gemini-2.0-flash-exp-media-generation': { sizes: ['1024x1024', '512x512'], edit: false, transparent: false, maxN: 4, format: 'b64_json' },
  // Flux models
  'flux-schnell': { sizes: ['512x512', '768x768', '1024x1024', '1536x1024', '1024x1536'], edit: false, transparent: false, maxN: 4, format: 'url' },
  'flux-pro': { sizes: ['512x512', '768x768', '1024x1024', '1536x1024', '1024x1536'], edit: false, transparent: true, maxN: 4, format: 'url' },
  // Stable Diffusion
  'stable-diffusion-xl': { sizes: ['512x512', '768x768', '1024x1024'], edit: true, transparent: false, maxN: 4, format: 'url' },
}

function getModelCapabilities(model) {
  // 1. Exact match
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model]
  // 2. Prefix match: known model name is prefix of user's model (e.g. "gpt-image-2-turbo" starts with "gpt-image-2")
  const lower = model.toLowerCase()
  for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.startsWith(key)) return caps
  }
  // 3. Contains match: user's model contains known name (e.g. "my-gpt-image-2-fork" contains "gpt-image-2")
  for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.includes(key)) return caps
  }
  // 4. Pattern-based defaults
  if (/image/i.test(lower)) return { sizes: ['512x512', '1024x1024'], edit: false, transparent: false, maxN: 4, format: 'url' }
  // Unknown
  return null
}

function loadProviderFromEnv(prefix) {
  const name = process.env[`${prefix}_NAME`]
  const baseUrl = process.env[`${prefix}_BASE_URL`]
  const apiKey = process.env[`${prefix}_API_KEY`]
  const model = process.env[`${prefix}_MODEL`]

  if (isUnset(baseUrl) || isUnset(apiKey) || isUnset(model)) return null

  const cleanedUrl = baseUrl.replace(/\/+$/, '')

  // Validate provider baseUrl is not a private/internal address
  try {
    const parsed = new URL(cleanedUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || isPrivateHostname(parsed.hostname)) {
      throw new Error('不允许的 provider URL')
    }
  } catch (err) {
    console.error(`[media-gen] Skipping ${prefix}: ${err.message}`)
    return null
  }

  return {
    name: (!isUnset(name) && name) || model,
    baseUrl: cleanedUrl,
    apiKey,
    model,
    enabled: true,
    timeoutMs: 300_000,
    capabilities: getModelCapabilities(model),
  }
}

function loadProviders() {
  const providers = []

  for (let i = 1; i <= 3; i++) {
    const p = loadProviderFromEnv(`MEDIA_GEN_P${i}`)
    if (p) providers.push(p)
  }

  if (providers.length === 0) {
    return []
  }

  return providers
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function trimSlash(s) {
  return s.replace(/\/+$/, '')
}

function jsonHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const MAX_JSON_BYTES = 35 * 1024 * 1024
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

async function readBodyWithLimit(res, maxBytes, label) {
  const limitError = () => new Error(`${label}: 响应超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 限制`)
  const contentLength = Number(res.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await res.body?.cancel()
    throw limitError()
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw limitError()
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

async function readJson(res) {
  const text = (await readBodyWithLimit(res, MAX_JSON_BYTES, 'provider JSON')).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function pickError(data, fallback) {
  if (data?.error) {
    if (typeof data.error === 'string') return data.error
    if (typeof data.error?.message === 'string') return data.error.message
  }
  if (typeof data?.message === 'string') return data.message
  return fallback
}

function extensionFromMime(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/png':
    default:
      return 'png'
  }
}

async function saveImageBuffer(buffer, outputDir, mimeType = 'image/png') {
  if (!outputDir || typeof outputDir !== 'string' || outputDir.trim() === '') return null
  const dir = path.resolve(outputDir)
  await mkdir(dir, { recursive: true })
  const filename = `image-${Date.now()}-${randomUUID()}.${extensionFromMime(mimeType)}`
  const filePath = path.join(dir, filename)
  await writeFile(filePath, buffer)
  return filePath
}

async function saveBase64Image(base64, outputDir, mimeType = 'image/png') {
  const estimatedBytes = Math.floor((base64.length * 3) / 4)
  if (estimatedBytes > MAX_IMAGE_BYTES) throw new Error('生成图超过 25 MB 限制')
  return saveImageBuffer(Buffer.from(base64, 'base64'), outputDir, mimeType)
}

async function saveUrlImage(imageUrl, outputDir) {
  if (!outputDir || typeof outputDir !== 'string' || outputDir.trim() === '') return null
  const res = await fetchSafeUrl(imageUrl, { method: 'GET' }, 30_000, 'image_url')
  if (!res.ok) throw new Error(`下载生成图失败: HTTP ${res.status}`)
  const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png'
  if (!mimeType.startsWith('image/')) throw new Error(`下载生成图失败: 响应不是图片 (${mimeType})`)
  const buffer = await readBodyWithLimit(res, MAX_IMAGE_BYTES, '下载生成图失败')
  return saveImageBuffer(buffer, outputDir, mimeType)
}

// ─── Compatibility fallback (from spriteflow) ─────────────────────────────────

function shouldRetryWithMinimalPayload(error) {
  const msg = error instanceof Error ? error.message : String(error || '')
  return /ECONNRESET|connection was reset|unsupported.*response_format|unsupported.*background|unknown parameter|unrecognized parameter/i.test(msg)
}

function buildImageBody(model, prompt, size, n, transparent, minimal, aspectRatio, resolution) {
  const isGrok = /^grok-imagine-(?:image|edit)(?:-|$)/i.test(model)
  const body = isGrok
    ? { model, prompt, n: n || 1 }
    : { model, prompt, n: n || 1, size: size || '1024x1024' }
  if (isGrok && aspectRatio !== undefined) body.aspect_ratio = aspectRatio
  if (isGrok && resolution !== undefined) body.resolution = resolution
  if (!minimal) {
    body.response_format = 'b64_json'
    if (transparent) body.background = 'transparent'
  }
  return body
}

async function resolveImageResult(data) {
  const first = data?.data?.[0]
  if (!first) throw new Error('图像接口没有返回数据')
  if (first.b64_json) return { type: 'base64', data: first.b64_json }
  if (first.url) return { type: 'url', data: first.url }
  throw new Error('图像响应缺少 b64_json 或 url')
}

// ─── Core: generate with provider fallback ────────────────────────────────────

function shouldRetryWithV1Prefix(baseUrl, error) {
  const msg = error instanceof Error ? error.message : String(error || '')
  return /HTTP (403|404)/.test(msg) && !/\/v1(\/|$)/.test(baseUrl)
}

async function generateWithFallback(prompt, size, n, transparent, providers, aspectRatio, resolution) {
  const errors = []

  for (const provider of providers) {
    if (!provider.enabled && provider.enabled !== undefined) continue
    const baseUrl = trimSlash(provider.baseUrl)
    const url = `${baseUrl}/images/generations`
    const timeoutMs = provider.timeoutMs || 300_000

    // Attempt 1: full params
    try {
      const body = buildImageBody(provider.model, prompt, size, n, transparent, false, aspectRatio, resolution)
      const res = await fetchSafeUrl(url, {
        method: 'POST',
        headers: jsonHeaders(provider.apiKey),
        body: JSON.stringify(body),
      }, timeoutMs)
      const data = await readJson(res)
      if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
      const result = await resolveImageResult(data)
      return { ...result, provider: provider.name, model: provider.model, warnings: [] }
    } catch (err1) {
      // Attempt 2: retry with /v1 prefix if base URL is missing it (common misconfiguration)
      if (shouldRetryWithV1Prefix(baseUrl, err1)) {
        const v1Url = `${baseUrl}/v1/images/generations`
        // Try /v1 with full params first
        try {
          const body = buildImageBody(provider.model, prompt, size, n, transparent, false, aspectRatio, resolution)
          const res = await fetchSafeUrl(v1Url, {
            method: 'POST',
            headers: jsonHeaders(provider.apiKey),
            body: JSON.stringify(body),
          }, timeoutMs)
          const data = await readJson(res)
          if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
          const result = await resolveImageResult(data)
          return {
            ...result,
            provider: provider.name,
            model: provider.model,
            warnings: [`[${provider.name}] 自动添加 /v1 前缀重试成功（建议更新 BASE_URL 为 ${baseUrl}/v1）`],
          }
        } catch (err1v1) {
          // Try /v1 with minimal params (some providers reject response_format etc.)
          try {
            const body = buildImageBody(provider.model, prompt, size, n, transparent, true, aspectRatio, resolution)
            const res = await fetchSafeUrl(v1Url, {
              method: 'POST',
              headers: jsonHeaders(provider.apiKey),
              body: JSON.stringify(body),
            }, timeoutMs)
            const data = await readJson(res)
            if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
            const result = await resolveImageResult(data)
            return {
              ...result,
              provider: provider.name,
              model: provider.model,
              warnings: [`[${provider.name}] 自动添加 /v1 前缀 + 兼容模式重试成功（建议更新 BASE_URL 为 ${baseUrl}/v1）`],
            }
          } catch {
            // Fall through to other retry strategies
          }
        }
      }
      // Attempt 3: minimal params (compatibility fallback)
      if (shouldRetryWithMinimalPayload(err1)) {
        try {
          const body = buildImageBody(provider.model, prompt, size, n, transparent, true, aspectRatio, resolution)
          const res = await fetchSafeUrl(url, {
            method: 'POST',
            headers: jsonHeaders(provider.apiKey),
            body: JSON.stringify(body),
          }, timeoutMs)
          const data = await readJson(res)
          if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
          const result = await resolveImageResult(data)
          return {
            ...result,
            provider: provider.name,
            model: provider.model,
            warnings: [`[${provider.name}] 使用兼容模式（精简参数）重试成功`],
          }
        } catch (err2) {
          errors.push({ provider: provider.name, error: err2.message })
          continue
        }
      }
      errors.push({ provider: provider.name, error: err1.message })
    }
  }

  return {
    type: 'error',
    error: `所有 provider 均失败:\n${errors.map(e => `  - ${e.provider}: ${e.error}`).join('\n')}`,
  }
}

// ─── Core: edit with provider fallback ────────────────────────────────────────

async function editWithFallback(prompt, imageUrl, size, n, transparent, providers) {
  const errors = []

  for (const provider of providers) {
    if (!provider.enabled && provider.enabled !== undefined) continue
    const baseUrl = trimSlash(provider.baseUrl)
    const url = `${baseUrl}/images/edits`
    const timeoutMs = provider.timeoutMs || 600_000

    // Fetch reference image as blob (with SSRF protection)
    let imageBlob
    try {
      if (imageUrl.startsWith('data:')) {
        const [meta, b64] = imageUrl.split(',')
        const mime = meta.match(/data:([^;]+)/)?.[1] || 'image/png'
        const buf = Buffer.from(b64, 'base64')
        imageBlob = new Blob([buf], { type: mime })
      } else {
        const imgRes = await fetchSafeUrl(imageUrl, { method: 'GET' }, 30_000, 'image_url')
        if (!imgRes.ok) throw new Error(`下载参考图失败: HTTP ${imgRes.status}`)
        const mime = imgRes.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
        if (!mime.startsWith('image/')) throw new Error(`下载参考图失败: 响应不是图片 (${mime})`)
        const buffer = await readBodyWithLimit(imgRes, MAX_IMAGE_BYTES, '下载参考图失败')
        imageBlob = new Blob([buffer], { type: mime })
      }
    } catch (imgErr) {
      errors.push({ provider: provider.name, error: `参考图获取失败: ${imgErr.message}` })
      continue
    }

    async function attemptEdit(editUrl, form) {
      const res = await fetchSafeUrl(editUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: form,
      }, timeoutMs)
      const data = await readJson(res)
      if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
      return resolveImageResult(data)
    }

    function buildFullForm() {
      const form = new FormData()
      form.set('model', provider.model)
      form.set('prompt', prompt)
      form.set('n', String(n || 1))
      form.set('size', size || '1024x1024')
      form.set('response_format', 'b64_json')
      if (transparent) form.set('background', 'transparent')
      form.append('image', imageBlob, 'reference.png')
      return form
    }

    function buildMinimalForm() {
      const form = new FormData()
      form.set('model', provider.model)
      form.set('prompt', prompt)
      form.set('n', String(n || 1))
      form.set('size', size || '1024x1024')
      form.append('image', imageBlob, 'reference.png')
      return form
    }

    // Attempt 1: full params
    try {
      const result = await attemptEdit(url, buildFullForm())
      return { ...result, provider: provider.name, model: provider.model, warnings: [] }
    } catch (err1) {
      // Attempt 2: retry with /v1 prefix if base URL is missing it
      if (shouldRetryWithV1Prefix(baseUrl, err1)) {
        try {
          const v1Url = `${baseUrl}/v1/images/edits`
          const result = await attemptEdit(v1Url, buildFullForm())
          return {
            ...result,
            provider: provider.name,
            model: provider.model,
            warnings: [`[${provider.name}] 自动添加 /v1 前缀重试成功（建议更新 BASE_URL 为 ${baseUrl}/v1）`],
          }
        } catch (err1v1) {
          // Fall through to minimal payload attempt
        }
      }
      // Attempt 3: minimal params
      if (shouldRetryWithMinimalPayload(err1)) {
        try {
          const result = await attemptEdit(url, buildMinimalForm())
          return {
            ...result,
            provider: provider.name,
            model: provider.model,
            warnings: [`[${provider.name}] 使用兼容模式（精简参数）重试成功`],
          }
        } catch (err2) {
          errors.push({ provider: provider.name, error: err2.message })
          continue
        }
      }
      errors.push({ provider: provider.name, error: err1.message })
    }
  }

  return {
    type: 'error',
    error: `所有 provider 均失败:\n${errors.map(e => `  - ${e.provider}: ${e.error}`).join('\n')}`,
  }
}

// ─── Core: asynchronous video generation ─────────────────────────────────────

async function pollGrokVideo(provider, baseUrl, requestId, timeoutSeconds) {
  const statusUrl = `${baseUrl}/videos/${encodeURIComponent(requestId)}`
  await resolvePublicAddresses(statusUrl, 'video_status_url')
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutSeconds) || 600, 1), 1800) * 1000
  let lastState = 'unknown'
  while (Date.now() < deadline) {
    const statusRes = await fetchSafeUrl(statusUrl, {
      method: 'GET', headers: { Authorization: `Bearer ${provider.apiKey}` },
    }, Math.min(provider.timeoutMs || 60_000, 60_000))
    const status = await readJson(statusRes)
    if (!statusRes.ok && statusRes.status !== 202) throw new Error(pickError(status, `HTTP ${statusRes.status}`))
    const state = String(status.status || '').toLowerCase()
    lastState = state || 'unknown'
    if (['failed', 'expired'].includes(state)) throw new Error(pickError(status, `Grok 视频任务失败 (${state})`))
    if (state === 'done') {
      const videoUrl = status.video?.url
      if (!videoUrl) throw new Error('Grok 视频任务已完成但未返回 video.url')
      await resolvePublicAddresses(videoUrl, 'video_url')
      return { url: videoUrl, provider: provider.name, model: provider.model, videoId: requestId }
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  throw new Error(`Grok 视频任务等待超时，任务 ID: ${requestId}，最后状态: ${lastState}`)
}

async function generateGrokVideo(prompt, provider, args, baseUrl) {
  const requestedDuration = args.duration === undefined ? 8 : Number(args.duration)
  const duration = Math.min(Math.max(Math.floor(requestedDuration), 1), 15)
  const body = { model: provider.model, prompt, duration }
  if (args.aspect_ratio !== undefined) body.aspect_ratio = args.aspect_ratio
  if (args.resolution !== undefined) body.resolution = args.resolution
  if (args.image_url !== undefined) body.image_url = args.image_url

  const createRes = await fetchSafeUrl(`${baseUrl}/videos/generations`, {
    method: 'POST',
    headers: jsonHeaders(provider.apiKey),
    body: JSON.stringify(body),
  }, provider.timeoutMs || 300_000)
  const created = await readJson(createRes)
  if (!createRes.ok) throw new Error(pickError(created, `HTTP ${createRes.status}`))
  const requestId = created.request_id
  if (!requestId) throw new Error('Grok 视频接口未返回 request_id')

  return pollGrokVideo(provider, baseUrl, requestId, args.timeout_seconds)
}

async function editGrokVideo(prompt, videoUrl, provider, args) {
  const baseUrl = trimSlash(provider.baseUrl)
  const createRes = await fetchSafeUrl(`${baseUrl}/videos/edits`, {
    method: 'POST',
    headers: jsonHeaders(provider.apiKey),
    body: JSON.stringify({ model: provider.model, prompt, video: { url: videoUrl } }),
  }, provider.timeoutMs || 300_000)
  const created = await readJson(createRes)
  if (!createRes.ok) throw new Error(pickError(created, `HTTP ${createRes.status}`))
  if (!created.request_id) throw new Error('Grok 视频编辑接口未返回 request_id')
  return pollGrokVideo(provider, baseUrl, created.request_id, args.timeout_seconds)
}

async function extendGrokVideo(prompt, videoUrl, provider, args) {
  const baseUrl = trimSlash(provider.baseUrl)
  const requestedDuration = args.duration === undefined ? 6 : Number(args.duration)
  const duration = Math.min(Math.max(Math.floor(requestedDuration), 1), 10)
  const body = { model: provider.model, prompt, video: { url: videoUrl }, duration }
  if (args.output_upload_url !== undefined) body.output = { upload_url: args.output_upload_url }
  const createRes = await fetchSafeUrl(`${baseUrl}/videos/extensions`, {
    method: 'POST', headers: jsonHeaders(provider.apiKey), body: JSON.stringify(body),
  }, provider.timeoutMs || 300_000)
  const created = await readJson(createRes)
  if (!createRes.ok) throw new Error(pickError(created, `HTTP ${createRes.status}`))
  if (!created.request_id) throw new Error('Grok 视频扩展接口未返回 request_id')
  return pollGrokVideo(provider, baseUrl, created.request_id, args.timeout_seconds)
}

async function generateVideo(prompt, provider, args) {
  const baseUrl = trimSlash(provider.baseUrl)
  if (/^grok-imagine-video(?:-|$)/i.test(provider.model)) {
    return generateGrokVideo(prompt, provider, args, baseUrl)
  }
  const createUrl = `${baseUrl}/videos`
  const body = { model: provider.model, prompt }
  for (const key of ['image', 'mode', 'height', 'width', 'num_frames', 'frame_rate', 'num_inference_steps', 'seed', 'negative_prompt']) {
    if (args[key] !== undefined) body[key] = args[key]
  }

  const createRes = await fetchSafeUrl(createUrl, {
    method: 'POST',
    headers: jsonHeaders(provider.apiKey),
    body: JSON.stringify(body),
  }, provider.timeoutMs || 300_000)
  const created = await readJson(createRes)
  if (!createRes.ok) throw new Error(pickError(created, `HTTP ${createRes.status}`))

  const videoId = created.video_id || created.id || created.task_id
  if (!videoId) throw new Error('视频接口未返回 video_id、id 或 task_id')

  const pollUrl = new URL(`${baseUrl.replace(/\/v1$/, '')}/agnesapi`)
  pollUrl.searchParams.set('video_id', videoId)
  await resolvePublicAddresses(pollUrl.href, 'video_status_url')
  const deadline = Date.now() + Math.min(Math.max(Number(args.timeout_seconds) || 600, 1), 1800) * 1000

  let transientFailures = 0
  let lastState = 'unknown'
  while (Date.now() < deadline) {
    try {
      const statusRes = await fetchSafeUrl(pollUrl.href, {
        method: 'GET',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
      }, Math.min(provider.timeoutMs || 60_000, 60_000))
      const status = await readJson(statusRes)
      if (!statusRes.ok) {
        const retryable = statusRes.status === 429 || statusRes.status >= 500
        if (!retryable) throw new Error(pickError(status, `HTTP ${statusRes.status}`))
        throw Object.assign(new Error(pickError(status, `HTTP ${statusRes.status}`)), { transient: true })
      }

      transientFailures = 0
      const state = String(status.status || '').toLowerCase()
      lastState = state || 'unknown'
      if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(state)) {
        throw new Error(pickError(status, `视频生成失败 (${state})`))
      }
      if (state === 'completed' || (!state && status.url)) {
        if (!status.url) throw new Error('视频任务已完成但未返回 URL')
        await resolvePublicAddresses(status.url, 'video_url')
        return { url: status.url, provider: provider.name, model: provider.model, videoId }
      }
    } catch (error) {
      if (!error.transient && !/fetch failed|ECONNRESET|ETIMEDOUT|aborted/i.test(error.message)) throw error
      transientFailures += 1
      if (transientFailures > 3) {
        throw new Error(`视频状态查询连续失败，任务 ID: ${videoId}: ${error.message}`)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 3000 * transientFailures || 3000))
  }

  throw new Error(`视频生成等待超时，任务 ID: ${videoId}，最后状态: ${lastState}`)
}

// ─── List models for a provider ───────────────────────────────────────────────

async function listModelsForProvider(provider) {
  const baseUrl = trimSlash(provider.baseUrl)
  const timeoutMs = Math.min(60_000, provider.timeoutMs || 60_000)

  async function tryFetchModels(modelsUrl) {
    const res = await fetchSafeUrl(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
    }, timeoutMs)
    const data = await readJson(res)
    if (!res.ok) throw new Error(pickError(data, `HTTP ${res.status}`))
    const ids = Array.isArray(data?.data)
      ? data.data.map(m => typeof m === 'string' ? m : m?.id).filter(Boolean)
      : []
    return { success: true, models: ids }
  }

  try {
    return await tryFetchModels(`${baseUrl}/models`)
  } catch (err) {
    // Retry with /v1 prefix if missing
    if (shouldRetryWithV1Prefix(baseUrl, err)) {
      try {
        return await tryFetchModels(`${baseUrl}/v1/models`)
      } catch {
        // fall through
      }
    }
    return { success: false, error: err.message, models: [] }
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt. Tries providers in priority order with automatic fallback. Supports any OpenAI-compatible image generation API (Agnes, GPT-image-2, Gemini, DALL-E, Flux, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image to generate',
        },
        size: {
          type: 'string',
          description: 'Image size for non-Grok providers (e.g. "1024x1024", "512x512", "auto"). Default: 1024x1024',
          default: '1024x1024',
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', 'auto'],
          description: 'Grok image aspect ratio.',
        },
        resolution: {
          type: 'string',
          enum: ['1k', '2k'],
          description: 'Grok image resolution.',
        },
        n: {
          type: 'number',
          description: 'Number of images to generate. Default: 1',
          default: 1,
        },
        transparent: {
          type: 'boolean',
          description: 'Request transparent background (not supported by all providers). Default: false',
          default: false,
        },
        output_dir: {
          type: 'string',
          description: 'Optional local directory to save generated images. When omitted, images are returned without saving to disk.',
        },
        provider_index: {
          type: 'integer',
          minimum: 0,
          description: 'Use only this configured provider (0-based). Omit for priority-order fallback.',
        },
        model: {
          type: 'string',
          description: 'Override the selected provider model. Requires provider_index.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description: 'Edit an existing image using a text prompt and a reference image. Tries providers in priority order with automatic fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the desired edit',
        },
        image_url: {
          type: 'string',
          description: 'URL or data URL of the reference image to edit',
        },
        size: {
          type: 'string',
          description: 'Output image size. Default: 1024x1024',
          default: '1024x1024',
        },
        n: {
          type: 'number',
          description: 'Number of images to generate. Default: 1',
          default: 1,
        },
        transparent: {
          type: 'boolean',
          description: 'Request transparent background. Default: false',
          default: false,
        },
        output_dir: {
          type: 'string',
          description: 'Optional local directory to save edited images. When omitted, images are returned without saving to disk.',
        },
        provider_index: {
          type: 'integer',
          minimum: 0,
          description: 'Use only this configured provider (0-based). Omit for priority-order fallback.',
        },
        model: {
          type: 'string',
          description: 'Override the selected provider model. Requires provider_index.',
        },
      },
      required: ['prompt', 'image_url'],
    },
  },
  {
    name: 'generate_video',
    description: 'Generate a video with an Agnes-compatible asynchronous video API. Requires an explicit provider index; does not fall back across providers.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the video to generate' },
        provider_index: { type: 'integer', minimum: 0, description: 'Configured video provider index (0-based)' },
        model: { type: 'string', description: 'Optional video model override for the selected provider' },
        image_url: { type: 'string', description: 'Grok image-to-video reference image as an HTTPS URL or data URL.' },
        image: { type: 'string', description: 'Agnes image-to-video reference image.' },
        mode: { type: 'string', description: 'Optional provider-specific generation mode' },
        width: { type: 'number', description: 'Optional output width' },
        height: { type: 'number', description: 'Optional output height' },
        num_frames: { type: 'number', description: 'Optional number of video frames' },
        frame_rate: { type: 'number', description: 'Optional frame rate' },
        num_inference_steps: { type: 'number', description: 'Optional inference step count' },
        seed: { type: 'number', description: 'Optional random seed' },
        negative_prompt: { type: 'string', description: 'Optional negative prompt' },
        duration: { type: 'integer', minimum: 1, maximum: 15, description: 'Grok video duration in seconds. Default: 8; maximum: 15.' },
        aspect_ratio: { type: 'string', description: 'Grok video aspect ratio. Default: 16:9.' },
        resolution: { type: 'string', enum: ['480p', '720p'], description: 'Grok video resolution. Default: 480p.' },
        timeout_seconds: { type: 'number', description: 'Maximum polling time in seconds. Default: 600; maximum: 1800.', default: 600 },
      },
      required: ['prompt', 'provider_index'],
    },
  },
  {
    name: 'edit_video',
    description: 'Edit an existing MP4 video with a Grok-compatible video editing API.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Requested edit; sent to the provider without rewriting' },
        video_url: { type: 'string', description: 'Source MP4 as a public URL or video/mp4 data URL' },
        provider_index: { type: 'integer', minimum: 0, description: 'Configured Grok provider index (0-based)' },
        model: { type: 'string', description: 'Optional Grok video model override' },
        timeout_seconds: { type: 'number', default: 600, description: 'Maximum polling time in seconds' },
      },
      required: ['prompt', 'video_url', 'provider_index'],
    },
  },
  {
    name: 'extend_video',
    description: 'Extend an existing MP4 video with a Grok-compatible video extension API.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of how the video should continue' },
        video_url: { type: 'string', description: 'Source MP4 as a public URL or video/mp4 data URL (2-30 seconds)' },
        provider_index: { type: 'integer', minimum: 0, description: 'Configured Grok provider index (0-based)' },
        model: { type: 'string', description: 'Optional Grok video model override' },
        duration: { type: 'integer', minimum: 1, maximum: 10, default: 6, description: 'Seconds to extend. Default: 6; maximum: 10.' },
        output_upload_url: { type: 'string', description: 'Optional provider upload URL for the completed output' },
        timeout_seconds: { type: 'number', default: 600, description: 'Maximum polling time in seconds' },
      },
      required: ['prompt', 'video_url', 'provider_index'],
    },
  },
  {
    name: 'list_providers',
    description: 'List all configured image generation providers with their status and priority order.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_models',
    description: 'List available models from all configured providers (calls each provider\'s /v1/models endpoint).',
    inputSchema: {
      type: 'object',
      properties: {
        provider_index: {
          type: 'number',
          description: 'Only query a specific provider by index (0-based). Omit to query all.',
        },
      },
    },
  },
]

// ─── MCP JSON-RPC server ──────────────────────────────────────────────────────

async function formatResult(result, outputDir) {
  if (result.type === 'error') {
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    }
  }

  const parts = []
  const meta = []
  let savedPath = null

  if (result.type === 'base64') {
    savedPath = await saveBase64Image(result.data, outputDir, 'image/png')
    if (savedPath) {
      parts.push({
        type: 'text',
        text: `![generated-image](${pathToFileURL(savedPath).href})`,
      })
    } else {
      parts.push({
        type: 'image',
        data: result.data,
        mimeType: 'image/png',
      })
    }
  }

  if (result.type === 'url') {
    savedPath = await saveUrlImage(result.data, outputDir)
    const displayUrl = savedPath ? pathToFileURL(savedPath).href : result.data
    // MCP content schema only allows text/image/audio/resource/resource_link.
    // We return the URL in a standard text block. The CLI MCP client layer
    // (transformResultContent) detects image URLs and converts them to
    // Anthropic API's {type:'image', source:{type:'url', url}} format,
    // which avoids accumulating base64 data in conversation history.
    // Desktop's extractImageBlocks also handles image_url annotations
    // embedded in the _meta field for inline rendering.
    parts.push({
      type: 'text',
      text: `![generated-image](${displayUrl})`,
    })
  }

  if (result.provider) meta.push(`Provider: ${result.provider}`)
  if (result.model) meta.push(`Model: ${result.model}`)
  if (result.warnings?.length) meta.push(...result.warnings)
  if (result.type === 'url') meta.push(`URL: ${result.data}`)
  if (savedPath) meta.push(`Saved to: ${savedPath}`)
  if (meta.length) parts.push({ type: 'text', text: meta.join('\n') })

  // Attach image_url annotation for Desktop inline rendering (non-standard
  // but safe: _meta is ignored by MCP schema validation, and Desktop's
  // extractImageBlocks reads it for URL-based images).
  if (result.type === 'url') {
    return {
      content: parts,
      isError: false,
      _meta: { imageUrls: [savedPath ? pathToFileURL(savedPath).href : result.data] },
    }
  }

  return { content: parts, isError: false }
}

// Cache providers at startup (env vars don't change during process lifetime)
const cachedProviders = loadProviders()

function selectProviders(providers, args) {
  if (args.model !== undefined && args.provider_index === undefined) {
    return { error: 'Error: model requires provider_index so the target provider is unambiguous.' }
  }
  if (args.provider_index === undefined) return { providers }

  const index = Number(args.provider_index)
  if (!Number.isInteger(index) || index < 0 || index >= providers.length) {
    return { error: `Invalid provider_index: ${args.provider_index}. Available range: 0-${providers.length - 1}.` }
  }

  const provider = providers[index]
  const model = typeof args.model === 'string' ? args.model.trim() : ''
  if (args.model !== undefined && model === '') {
    return { error: 'Error: model must be a non-empty string.' }
  }

  return {
    providers: [{
      ...provider,
      ...(model ? { model, capabilities: getModelCapabilities(model) } : {}),
    }],
  }
}

async function handleToolCall(name, args) {
  const providers = cachedProviders

  if (providers.length === 0) {
    return {
      content: [{ type: 'text', text: '没有可用的 provider。请在插件配置中设置 PROVIDERS_JSON。' }],
      isError: true,
    }
  }

  switch (name) {
    case 'generate_image': {
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        return { content: [{ type: 'text', text: 'Error: prompt is required and must be a non-empty string.' }], isError: true }
      }
      const selection = selectProviders(providers, args)
      if (selection.error) {
        return { content: [{ type: 'text', text: selection.error }], isError: true }
      }
      const selectedProviders = selection.providers
      const firstCaps = selectedProviders[0]?.capabilities
      const maxN = firstCaps?.maxN || 10
      const n = Math.min(Math.max(Math.floor(Number(args.n) || 1), 1), maxN)
      const requestedSize = args.size || '1024x1024'
      const sizeWarning = firstCaps && firstCaps.sizes.length > 0 && !firstCaps.sizes.includes(requestedSize) && requestedSize !== 'auto'
        ? `Size "${requestedSize}" may not be supported by ${selectedProviders[0].model}. Supported sizes: ${firstCaps.sizes.join(', ')}.`
        : null
      const result = await generateWithFallback(
        args.prompt.trim(),
        requestedSize,
        n,
        args.transparent,
        selectedProviders,
        args.aspect_ratio,
        args.resolution,
      )
      if (sizeWarning && result.type !== 'error') result.warnings = [sizeWarning, ...(result.warnings || [])]
      return await formatResult(result, args.output_dir)
    }

    case 'edit_image': {
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        return { content: [{ type: 'text', text: 'Error: prompt is required.' }], isError: true }
      }
      if (!args.image_url || typeof args.image_url !== 'string') {
        return { content: [{ type: 'text', text: 'Error: image_url is required.' }], isError: true }
      }
      const selection = selectProviders(providers, args)
      if (selection.error) {
        return { content: [{ type: 'text', text: selection.error }], isError: true }
      }
      const editProviders = selection.providers.filter(p => p.capabilities?.edit !== false)
      if (editProviders.length === 0) {
        return {
          content: [{ type: 'text', text: 'None of the configured providers support image editing. Use generate_image instead, or add a provider that supports editing (e.g., gpt-image-2, gemini-2.5-flash-image-preview).' }],
          isError: true,
        }
      }
      const result = await editWithFallback(
        args.prompt.trim(),
        args.image_url,
        args.size || '1024x1024',
        args.n || 1,
        args.transparent,
        editProviders,
      )
      return await formatResult(result, args.output_dir)
    }

    case 'generate_video': {
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        return { content: [{ type: 'text', text: 'Error: prompt is required and must be a non-empty string.' }], isError: true }
      }
      if (args.provider_index === undefined) {
        return { content: [{ type: 'text', text: 'Error: generate_video requires provider_index.' }], isError: true }
      }
      const selection = selectProviders(providers, args)
      if (selection.error) {
        return { content: [{ type: 'text', text: selection.error }], isError: true }
      }
      try {
        const result = await generateVideo(args.prompt.trim(), selection.providers[0], args)
        return {
          content: [{ type: 'text', text: `Video: ${result.url}\nProvider: ${result.provider}\nModel: ${result.model}\nTask ID: ${result.videoId}` }],
          isError: false,
          _meta: { videoUrls: [result.url] },
        }
      } catch (error) {
        return { content: [{ type: 'text', text: `视频生成失败: ${error.message}` }], isError: true }
      }
    }

    case 'edit_video': {
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        return { content: [{ type: 'text', text: 'Error: prompt is required.' }], isError: true }
      }
      if (!args.video_url || typeof args.video_url !== 'string') {
        return { content: [{ type: 'text', text: 'Error: video_url is required.' }], isError: true }
      }
      if (args.provider_index === undefined) {
        return { content: [{ type: 'text', text: 'Error: edit_video requires provider_index.' }], isError: true }
      }
      const selection = selectProviders(providers, args)
      if (selection.error) return { content: [{ type: 'text', text: selection.error }], isError: true }
      const provider = selection.providers[0]
      if (!/^grok-imagine-video(?:-|$)/i.test(provider.model)) {
        return { content: [{ type: 'text', text: 'Error: edit_video requires a Grok video model.' }], isError: true }
      }
      try {
        const result = await editGrokVideo(args.prompt.trim(), args.video_url, provider, args)
        return {
          content: [{ type: 'text', text: `Video: ${result.url}\nProvider: ${result.provider}\nModel: ${result.model}\nTask ID: ${result.videoId}` }],
          isError: false, _meta: { videoUrls: [result.url] },
        }
      } catch (error) {
        return { content: [{ type: 'text', text: `视频编辑失败: ${error.message}` }], isError: true }
      }
    }

    case 'extend_video': {
      if (!args.prompt || typeof args.prompt !== 'string' || args.prompt.trim() === '') {
        return { content: [{ type: 'text', text: 'Error: prompt is required.' }], isError: true }
      }
      if (!args.video_url || typeof args.video_url !== 'string') {
        return { content: [{ type: 'text', text: 'Error: video_url is required.' }], isError: true }
      }
      if (args.provider_index === undefined) {
        return { content: [{ type: 'text', text: 'Error: extend_video requires provider_index.' }], isError: true }
      }
      const selection = selectProviders(providers, args)
      if (selection.error) return { content: [{ type: 'text', text: selection.error }], isError: true }
      const provider = selection.providers[0]
      if (!/^grok-imagine-video(?:-|$)/i.test(provider.model)) {
        return { content: [{ type: 'text', text: 'Error: extend_video requires a Grok video model.' }], isError: true }
      }
      try {
        const result = await extendGrokVideo(args.prompt.trim(), args.video_url, provider, args)
        return {
          content: [{ type: 'text', text: `Video: ${result.url}\nProvider: ${result.provider}\nModel: ${result.model}\nTask ID: ${result.videoId}` }],
          isError: false, _meta: { videoUrls: [result.url] },
        }
      } catch (error) {
        return { content: [{ type: 'text', text: `视频扩展失败: ${error.message}` }], isError: true }
      }
    }

    case 'list_providers': {
      const lines = providers.map((p, i) => {
        const status = p.enabled === false ? ' [DISABLED]' : ''
        const caps = p.capabilities
        let capStr = ''
        if (caps) {
          const parts = []
          parts.push(`sizes: ${caps.sizes.join(', ')}`)
          if (caps.edit) parts.push('supports edit')
          if (caps.transparent) parts.push('supports transparent')
          parts.push(`max n: ${caps.maxN}`)
          parts.push(`returns: ${caps.format}`)
          if (caps.notes) parts.push(`note: ${caps.notes}`)
          capStr = `\n   capabilities: ${parts.join(' | ')}`
        } else {
          capStr = '\n   capabilities: unknown (will try all params, fallback on error)'
        }
        return `${i}. ${p.name}${status}\n   baseUrl: ${p.baseUrl}\n   model: ${p.model}${capStr}`
      })
      return {
        content: [{ type: 'text', text: `Configured providers (${providers.length}):\n\n${lines.join('\n\n')}` }],
        isError: false,
      }
    }

    case 'list_models': {
      const indices = args?.provider_index !== undefined
        ? [args.provider_index]
        : providers.map((_, i) => i)

      const results = []
      for (const idx of indices) {
        const p = providers[idx]
        if (!p) {
          results.push(`[${idx}] INVALID INDEX`)
          continue
        }
        const r = await listModelsForProvider(p)
        if (r.success) {
          const imageModels = r.models.filter(m =>
            /image|img|vision|dall|flux|stable|banana|gemini.*image|gpt-image|agnes-image/i.test(m)
          )
          results.push(`${p.name} (${r.models.length} models, ${imageModels.length} image models):\n  Image models: ${imageModels.join(', ') || '(none matched)'}\n  All: ${r.models.join(', ')}`)
        } else {
          results.push(`${p.name}: ERROR - ${r.error}`)
        }
      }
      return {
        content: [{ type: 'text', text: results.join('\n\n') }],
        isError: false,
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      }
  }
}

// ─── Stdio JSON-RPC transport ─────────────────────────────────────────────────

const MAX_BUFFER_SIZE = 1024 * 1024 // 1MB

function sendResponse(id, result) {
  const msg = { jsonrpc: '2.0', id, result }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function sendError(id, code, message) {
  const msg = { jsonrpc: '2.0', id, error: { code, message } }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function sendNotification(method, params) {
  const msg = { jsonrpc: '2.0', method, params }
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handleMessage(msg) {
  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'media-gen',
          version: '1.0.0',
        },
      })
      break

    case 'notifications/initialized':
      // no response needed for notification
      break

    case 'tools/list':
      sendResponse(id, { tools: TOOLS })
      break

    case 'tools/call': {
      try {
        const result = await handleToolCall(params.name, params.arguments || {})
        sendResponse(id, result)
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        })
      }
      break
    }

    case 'ping':
      sendResponse(id, {})
      break

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`)
      }
      break
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const rl = createInterface({ input: process.stdin })

  let buffer = ''
  const pending = new Set()

  rl.on('line', (line) => {
    buffer += line
    if (buffer.length > MAX_BUFFER_SIZE) {
      console.error(`[media-gen] Buffer overflow (>1MB), resetting`)
      buffer = ''
      return
    }
    try {
      const msg = JSON.parse(buffer)
      buffer = ''
      const p = handleMessage(msg).catch(err => {
        if (msg.id !== undefined) {
          sendError(msg.id, -32603, `Internal error: ${err.message}`)
        }
      }).finally(() => pending.delete(p))
      pending.add(p)
    } catch {
      // Incomplete message, wait for more lines
    }
  })

  rl.on('close', async () => {
    // Wait for all pending message handlers to complete before exiting
    if (pending.size > 0) {
      await Promise.allSettled([...pending])
    }
    process.exit(0)
  })

  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))

  // Log to stderr (not stdout, which is reserved for JSON-RPC)
  console.error('[media-gen] MCP server started')
}

main()
