/**
 * Zero-install cloudflared provisioning for the H5 one-click public tunnel.
 *
 * This module locates an existing cloudflared, and when none is found it
 * downloads a pinned official build into a version-scoped cache directory and
 * returns the absolute path to the executable. It is the download side of the
 * tunnel provider abstraction (`H5TunnelProvider` lives in ./tunnelProvider.ts).
 *
 * Design notes / known limits:
 *
 * - Asset mapping is keyed by `${platform}-${arch}`. Windows ARM64 is served by
 *   the amd64 build on purpose: Cloudflare publishes no `windows-arm64` asset
 *   (the 2026.9.3 release ships only `cloudflared-windows-amd64.exe` and
 *   `cloudflared-windows-386.exe`). Windows on ARM runs the amd64 binary under
 *   its x64 emulation layer, which is the accepted community workaround.
 *
 * - sha256 values are the authoritative GitHub release-asset digests for
 *   2026.9.3 (repos/cloudflare/cloudflared releases API `assets[].digest`,
 *   i.e. the SHA-256 of the exact bytes the download URL serves). Each value
 *   was independently confirmed by downloading the asset and hashing it locally
 *   on 2026-09-30. NOTE: the darwin .tgz entries in the release *notes* differ
 *   from the served bytes (the notes are stale for those two assets) — the
 *   values below intentionally follow the served bytes, which is what actually
 *   gets downloaded and verified at runtime.
 *
 * - HTTP(S) proxy: `https-proxy-agent` is already present in the desktop
 *   dependency tree, so when HTTPS_PROXY/https_proxy (or the HTTP variants) is
 *   set we pass an agent to node:https explicitly. When no proxy env is set we
 *   connect directly. If the agent module is ever removed from the dependency
 *   tree, downloads fall back to a direct connection (HTTP(S)_PROXY would then
 *   be unsupported).
 *
 * - Downloads follow up to 5 redirects (GitHub Releases 302s to
 *   objects.githubusercontent.com), time out a single request after 30s, and
 *   retry only connection-level failures (ECONNRESET/ECONNREFUSED/ETIMEDOUT)
 *   with exponential backoff.
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { basename, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolveCloudflaredPath } from './sidecarManager'

/** Pinned cloudflared release. Bump together with the asset table below. */
export const CLOUDFLARED_VERSION = '2026.9.3'

export type CloudflaredDownloadProgress = { receivedBytes: number, totalBytes: number | null }

export type CloudflaredAssetSpec = { asset: string, isTarGz: boolean, sha256: string }

type AssetTable = Record<string, CloudflaredAssetSpec>

/**
 * Pinned assets for CLOUDFLARED_VERSION.
 *
 * sha256 source: cloudflare/cloudflared 2026.9.3 release-asset digests
 * (`gh api repos/cloudflare/cloudflared/releases/tags/2026.9.3` ->
 * `assets[].digest`), each re-verified by hashing a fresh local download on
 * 2026-09-30. The darwin .tgz values differ from the release *notes* text,
 * which is stale for those two assets; these follow the served bytes.
 * Do not hand-edit these values; re-derive them from a verified release.
 */
const ASSETS: AssetTable = {
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', isTarGz: false, sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2' },
  // Windows ARM64 reuses the amd64 build: Cloudflare ships no windows-arm64
  // asset, and the amd64 binary runs under Windows' x64 emulation layer.
  'win32-arm64': { asset: 'cloudflared-windows-amd64.exe', isTarGz: false, sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2' },
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', isTarGz: true, sha256: 'd1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977' },
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', isTarGz: true, sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095' },
  'linux-x64': { asset: 'cloudflared-linux-amd64', isTarGz: false, sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2' },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', isTarGz: false, sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d' },
}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5
const DOWNLOAD_ATTEMPTS = 3
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'])
const DOWNLOAD_SUFFIX = '.download-'

/** Normalize Node's arch vocabulary onto the release's amd64/arm64 naming. */
function normalizeArch(arch: string): string {
  switch (arch) {
    case 'amd64':
    case 'x86_64':
    case 'x64':
      return 'x64'
    case 'aarch64':
    case 'arm64':
      return 'arm64'
    default:
      return arch
  }
}

/**
 * Resolve the pinned asset for a platform/arch pair, or null when no official
 * build exists. `amd64`/`x86_64` are normalized to `x64`.
 */
export function resolveAssetSpec(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CloudflaredAssetSpec | null {
  const spec = ASSETS[`${platform}-${normalizeArch(arch)}`]
  return spec ? { ...spec } : null
}

function executableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

function defaultBaseUrl(): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`
}

function sleepDefault(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function resolveProxyUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '').trim()
  return raw || null
}

// https-proxy-agent is present in the desktop dependency tree but is not a
// declared direct dependency. Load it lazily so a future install that drops it
// degrades to a direct connection instead of breaking module load.
let proxyAgentCtor: Promise<(new (url: string) => unknown) | null> | null = null
function loadProxyAgentCtor(): Promise<(new (url: string) => unknown) | null> {
  if (!proxyAgentCtor) {
    proxyAgentCtor = import('https-proxy-agent')
      .then(module => module.HttpsProxyAgent as unknown as new (url: string) => unknown)
      .catch(() => null)
  }
  return proxyAgentCtor
}

async function resolveProxyAgent(env: NodeJS.ProcessEnv): Promise<unknown | undefined> {
  const url = resolveProxyUrl(env)
  if (!url) return undefined
  const Ctor = await loadProxyAgentCtor()
  if (!Ctor) return undefined
  try {
    return new Ctor(url)
  } catch {
    return undefined
  }
}

function parseContentLength(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && RETRYABLE_CODES.has(code)
}

type DownloadFn = (url: string, dest: string, onProgress?: (p: CloudflaredDownloadProgress) => void) => Promise<void>

type DownloadDeps = {
  env: NodeJS.ProcessEnv
  sleep: (milliseconds: number) => Promise<void>
}

/**
 * Open a single response, following up to MAX_REDIRECTS redirects. Rejects on
 * non-200 terminal responses and on request-level timeouts (code ETIMEDOUT).
 */
async function openResponse(url: string, deps: DownloadDeps): Promise<IncomingMessage> {
  const agent = await resolveProxyAgent(deps.env)
  return new Promise((resolve, reject) => {
    let redirects = 0

    const visit = (currentUrl: string) => {
      const request = https.get(currentUrl, agent ? { agent: agent as unknown as import('node:http').Agent } : {}, (response) => {
        const status = response.statusCode ?? 0
        const location = response.headers.location

        if (status >= 300 && status < 400 && location) {
          response.resume()
          if (redirects >= MAX_REDIRECTS) {
            reject(new Error(`cloudflared download exceeded ${MAX_REDIRECTS} redirects for ${url}`))
            return
          }
          redirects += 1
          let next: string
          try {
            next = new URL(location, currentUrl).toString()
          } catch (error) {
            reject(error)
            return
          }
          visit(next)
          return
        }

        if (status !== 200) {
          response.resume()
          reject(new Error(`cloudflared download failed with HTTP ${status} for ${url}`))
          return
        }

        resolve(response)
      })

      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(Object.assign(new Error(`cloudflared download timed out after ${REQUEST_TIMEOUT_MS}ms`), { code: 'ETIMEDOUT' }))
      })
      request.on('error', reject)
      request.end()
    }

    visit(url)
  })
}

/**
 * Stream a response to disk. A connection reset after the 200 headers (GitHub
 * CDNs do this) surfaces as an 'aborted' event rather than an 'error'; we turn
 * it into an ECONNRESET so pipeline rejects instead of hanging forever.
 */
async function downloadOnce(url: string, dest: string, onProgress: ((p: CloudflaredDownloadProgress) => void) | undefined, deps: DownloadDeps): Promise<void> {
  const response = await openResponse(url, deps)
  const totalBytes = parseContentLength(response.headers['content-length'])
  let receivedBytes = 0

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length
      onProgress?.({ receivedBytes, totalBytes })
      callback(null, chunk)
    },
  })

  const onAborted = () => {
    response.destroy(Object.assign(new Error('cloudflared download aborted before completion'), { code: 'ECONNRESET' }))
  }
  response.on('aborted', onAborted)

  try {
    await pipeline(response, counter, createWriteStream(dest))
  } finally {
    response.off('aborted', onAborted)
  }
}

function createDefaultDownloader(deps: DownloadDeps): DownloadFn {
  return async (url, dest, onProgress) => {
    let lastError: unknown
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        await downloadOnce(url, dest, onProgress, deps)
        return
      } catch (error) {
        lastError = error
        if (!isRetryable(error) || attempt === DOWNLOAD_ATTEMPTS) throw error
        await deps.sleep(200 * 2 ** (attempt - 1))
      }
    }
    throw lastError
  }
}

function sha256File(filePath: string, hashFn?: (filePath: string) => string): string {
  if (hashFn) return hashFn(filePath)
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function sweepStaleDownloads(directory: string): void {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.includes(DOWNLOAD_SUFFIX)) rmSync(join(directory, entry), { force: true })
  }
}

function probeExecutable(command: string, spawnSyncFn: typeof spawnSync): boolean {
  try {
    const result = spawnSyncFn(command, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
    return result.status === 0
  } catch {
    return false
  }
}

function extractTarGz(archive: string, directory: string, spawnSyncFn: typeof spawnSync): void {
  // Run from the target directory using the archive's bare name. GNU tar (the
  // default on Windows via Git for Windows) reads the "C:" drive colon in an
  // absolute path as a remote host:file spec and fails with exit status 2.
  const result = spawnSyncFn('tar', ['-xzf', basename(archive)], { cwd: directory, stdio: 'ignore', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`Failed to extract ${archive} with the system tar (exit code ${result.status ?? 'unknown'}).`)
  }
}

/**
 * Options for ensureCloudflaredBinary. The first four keys are the integration
 * contract; the remaining keys are additive test seams so every side effect
 * (clock, process spawn, hashing, platform) can be substituted without touching
 * the network or the host platform.
 */
export type EnsureCloudflaredBinaryOptions = {
  cacheDir: string
  env?: NodeJS.ProcessEnv
  onProgress?: (p: CloudflaredDownloadProgress) => void
  downloadFn?: DownloadFn
  /** Test seam: pretend to run on another platform. Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Test seam: pretend to run on another architecture. Defaults to process.arch. */
  arch?: string
  /** Test seam: replace node:child_process spawnSync (used for probing and tar). */
  spawnSyncFn?: typeof spawnSync
  /** Test seam: replace the retry backoff delay. */
  sleepFn?: (milliseconds: number) => Promise<void>
  /** Test seam: replace the sha256 file hash. */
  hashFn?: (filePath: string) => string
}

/**
 * Return the absolute path to a runnable cloudflared, downloading and caching a
 * pinned official build when none is available.
 *
 * Resolution order:
 *   1. env.CLOUDFLARED_PATH explicit override
 *   2. a known install location (or a PATH-resolved cloudflared, probed with --version)
 *   3. the version-scoped cache (<cacheDir>/cloudflared/<version>/cloudflared[.exe])
 *   4. download
 */
export async function ensureCloudflaredBinary(options: EnsureCloudflaredBinaryOptions): Promise<string> {
  const { cacheDir, onProgress } = options
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync
  const sleep = options.sleepFn ?? sleepDefault

  const spec = resolveAssetSpec(platform, arch)
  if (!spec) throw new Error(`No cloudflared build is available for ${platform}-${arch}.`)

  const override = env.CLOUDFLARED_PATH?.trim()
  if (override && (existsSync(override) || probeExecutable(override, spawnSyncFn))) return override

  // resolveCloudflaredPath returns a bare command name when nothing is found, so
  // a bare name still has to be probed before we trust it.
  const known = resolveCloudflaredPath(env, { platform })
  if (known) {
    if (isAbsolute(known)) return known
    if (probeExecutable(known, spawnSyncFn)) return known
  }

  const versionDir = join(cacheDir, 'cloudflared', CLOUDFLARED_VERSION)
  const target = join(versionDir, executableName(platform))
  if (existsSync(target)) return target

  mkdirSync(versionDir, { recursive: true })
  sweepStaleDownloads(versionDir)

  const baseUrl = (env.CC_HAHA_CLOUDFLARED_BASE_URL?.trim() || defaultBaseUrl()).replace(/\/+$/, '')
  const url = `${baseUrl}/${spec.asset}`
  const download = options.downloadFn ?? createDefaultDownloader({ env, sleep })
  const tempPath = `${target}${DOWNLOAD_SUFFIX}${randomBytes(6).toString('hex')}`

  try {
    await download(url, tempPath, onProgress)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }

  const actualSha = sha256File(tempPath, options.hashFn)
  if (actualSha !== spec.sha256) {
    rmSync(tempPath, { force: true })
    throw new Error(`cloudflared checksum mismatch for ${spec.asset}: expected ${spec.sha256}, received ${actualSha}.`)
  }

  if (spec.isTarGz) {
    extractTarGz(tempPath, versionDir, spawnSyncFn)
    rmSync(tempPath, { force: true })
    if (!existsSync(target)) throw new Error(`cloudflared archive ${spec.asset} did not contain ${executableName(platform)}.`)
  } else {
    if (platform !== 'win32') chmodSync(tempPath, 0o755)
    renameSync(tempPath, target)
  }

  if (platform !== 'win32') chmodSync(target, 0o755)
  return target
}
