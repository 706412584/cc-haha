import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  VoiceDownloadError,
  isTerminal,
  isTransient,
  sanitizeOrigin,
  scrubUrls,
  toDownloadError,
} from './failure.js'

export type HashAlgorithm = 'sha256' | 'sha512'

export interface DownloadHash {
  algorithm: HashAlgorithm
  /** `hex` for sha256 files, `base64` for npm `sha512-...` integrity values. */
  encoding: 'hex' | 'base64'
  value: string
}

/** A pinned file: fixed size, fixed digest, one or more interchangeable URLs. */
export interface DownloadAsset {
  /** Resource label shown in progress and failures, e.g. `model.int8.onnx`. */
  name: string
  bytes: number
  hash: DownloadHash
  /** Mirrors in preference order; the fastest responder is tried first. */
  urls: string[]
}

export interface DownloadProgress {
  completedBytes: number
  totalBytes: number
  /** Bytes already on disk when this transfer resumed; absent for a fresh start. */
  resumedFromBytes?: number
  /** Origin serving the transfer. */
  source: string
}

export type FetchLike = (input: string, init?: RequestInit & Record<string, unknown>) => Promise<Response>

export interface DownloadOptions {
  fetch?: FetchLike
  /** Extra per-request fetch options such as the configured network proxy. */
  fetchOptions?: (url: string) => Promise<Record<string, unknown>> | Record<string, unknown>
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  /** Retries per source after network/timeout interruptions. Default 5. */
  maxRetries?: number
  /** First backoff delay; doubles each retry up to `maxBackoffMs`. Default 500. */
  backoffMs?: number
  maxBackoffMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Race HEAD probes across mirrors, at most this long. Default 3000. */
  probeTimeoutMs?: number
  /** Abort a transfer that receives nothing for this long. Default 30000. */
  idleTimeoutMs?: number
  /** Minimum gap between progress callbacks. Default 100. */
  progressIntervalMs?: number
}

export interface DownloadResult {
  /** Origin that delivered the final bytes. */
  source: string
  /** Last non-zero offset the transfer resumed from, if any resume happened. */
  resumedFromBytes?: number
}

export const DEFAULT_MAX_RETRIES = 5

export function partPathFor(destination: string): string {
  return `${destination}.part`
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function storageError(error: unknown, resource: string): VoiceDownloadError {
  if (error instanceof VoiceDownloadError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new VoiceDownloadError(
    { reason: 'storage', resource, message: scrubUrls(message) },
    { cause: error },
  )
}

async function fsCall<T>(resource: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw storageError(error, resource)
  }
}

/**
 * Writes the whole chunk. The running hash covers the network bytes, so a short
 * write that went unnoticed would leave a file that verifies yet is missing a
 * span; loop until everything is on disk and fail loudly if no progress is made.
 */
export async function writeFully(
  handle: { write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }> },
  chunk: Uint8Array,
): Promise<void> {
  let written = 0
  while (written < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, written, chunk.byteLength - written)
    if (bytesWritten <= 0) throw new Error('Short write: the file system accepted no more data')
    written += bytesWritten
  }
}

async function partSize(path: string, resource: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw storageError(error, resource)
  }
}

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {})
}

function feedPrefix(path: string, length: number, hash: Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start: 0, end: length - 1 })
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve())
  })
}

function digestMatches(hash: Hash, expected: DownloadHash): boolean {
  const actual = hash.digest(expected.encoding)
  return expected.encoding === 'hex' ? actual === expected.value.toLowerCase() : actual === expected.value
}

function parseContentRange(value: string | null): { start: number; end: number; total: number | undefined } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value?.trim() ?? '')
  if (!match) return undefined
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? undefined : Number(match[3]) }
}

/** Races cheap HEAD probes; unreachable mirrors are kept as later fallbacks. */
async function orderSources(
  urls: string[],
  fetchImpl: FetchLike,
  resolveOptions: (url: string) => Promise<Record<string, unknown>>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  if (urls.length < 2) return urls
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(new Error('probe timeout')), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
  try {
    const winner = await Promise.any(urls.map(async url => {
      const response = await fetchImpl(url, {
        method: 'HEAD',
        redirect: 'follow',
        // Bun re-issues a request on a reused socket that resets mid-body and
        // splices the retry into the stream; a fresh connection avoids that.
        keepalive: false,
        signal: combined,
        ...(await resolveOptions(url)),
      })
      await response.body?.cancel().catch(() => {})
      if (response.status >= 400) throw new Error(`probe ${response.status}`)
      return url
    }))
    return [winner, ...urls.filter(url => url !== winner)]
  } catch {
    signal?.throwIfAborted()
    return urls
  } finally {
    clearTimeout(timer)
    stop.abort(new Error('probe finished'))
  }
}

/**
 * Downloads one pinned file with resume, retry and mirror fallback.
 *
 * The partial file is `<destination>.part` (a deterministic name), so an
 * interrupted, cancelled or crashed download continues from its byte offset the
 * next time this is called. Only a digest mismatch deletes it. The final file
 * appears atomically via rename, and only after the digest matches.
 */
export async function downloadAsset(
  asset: DownloadAsset,
  destination: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init as RequestInit))
  const resolveOptions = async (url: string): Promise<Record<string, unknown>> =>
    (await options.fetchOptions?.(url)) ?? {}
  const sleep = options.sleep ?? defaultSleep
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const backoffMs = options.backoffMs ?? 500
  const maxBackoffMs = options.maxBackoffMs ?? 10_000
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000
  const progressIntervalMs = options.progressIntervalMs ?? 100
  const part = partPathFor(destination)
  const { signal } = options
  const resource = asset.name

  let resumedFromBytes: number | undefined
  let lastProgressAt = 0

  const report = (completedBytes: number, source: string, force: boolean): void => {
    if (!options.onProgress) return
    const now = performance.now()
    if (!force && now - lastProgressAt < progressIntervalMs) return
    lastProgressAt = now
    options.onProgress({
      completedBytes,
      totalBytes: asset.bytes,
      source,
      ...(resumedFromBytes ? { resumedFromBytes } : {}),
    })
  }

  await fsCall(resource, () => mkdir(dirname(destination), { recursive: true }))

  /** One transfer against one URL. Returns `restart` when the partial file was discarded. */
  const transfer = async (url: string, allowResume: boolean): Promise<DownloadResult | 'restart'> => {
    const source = sanitizeOrigin(url)
    let offset = allowResume ? await partSize(part, resource) : 0
    if (!allowResume) await removeQuietly(part)
    if (offset > asset.bytes) {
      await removeQuietly(part)
      offset = 0
    }
    const hash = createHash(asset.hash.algorithm)

    // A complete .part from an earlier run only needs verification.
    if (offset === asset.bytes) {
      await fsCall(resource, () => feedPrefix(part, offset, hash))
      if (!digestMatches(hash, asset.hash)) {
        await removeQuietly(part)
        return 'restart'
      }
      await fsCall(resource, () => rename(part, destination))
      resumedFromBytes = offset
      report(asset.bytes, source, true)
      return { source, resumedFromBytes: offset }
    }

    const attemptAbort = new AbortController()
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        attemptAbort.abort(new DOMException('No data received', 'TimeoutError'))
      }, idleTimeoutMs)
    }
    const combined = signal ? AbortSignal.any([signal, attemptAbort.signal]) : attemptAbort.signal
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
      armIdle()
      let response: Response
      try {
        response = await fetchImpl(url, {
          redirect: 'follow',
          keepalive: false,
          signal: combined,
          headers: {
            'Accept-Encoding': 'identity',
            ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
          },
          ...(await resolveOptions(url)),
        })
      } catch (error) {
        signal?.throwIfAborted()
        if (attemptAbort.signal.aborted) {
          throw new VoiceDownloadError({ reason: 'timeout', source, resource, message: 'No data received before the timeout' })
        }
        throw toDownloadError(error, { source, resource })
      }

      if (response.status === 416) {
        await response.body?.cancel().catch(() => {})
        if (offset === 0) {
          throw new VoiceDownloadError({ reason: 'http', source, resource, status: 416, message: 'HTTP 416 for a full download' })
        }
        await removeQuietly(part)
        return 'restart'
      }

      let resumed = false
      if (response.status === 206) {
        const range = parseContentRange(response.headers.get('content-range'))
        const consistent = offset > 0 && range
          && range.start === offset && range.end === asset.bytes - 1
          && (range.total === undefined || range.total === asset.bytes)
        if (!consistent) {
          await response.body?.cancel().catch(() => {})
          await removeQuietly(part)
          return 'restart'
        }
        resumed = true
      } else if (response.status === 200) {
        const length = response.headers.get('content-length')
        if (length !== null && Number(length) !== asset.bytes) {
          await response.body?.cancel().catch(() => {})
          throw new VoiceDownloadError({
            reason: 'integrity', source, resource,
            message: `Server reported ${length} bytes, expected ${asset.bytes}`,
          })
        }
        offset = 0
      } else {
        await response.body?.cancel().catch(() => {})
        throw new VoiceDownloadError({
          reason: 'http', source, resource, status: response.status,
          message: `HTTP ${response.status} from ${source}`,
        })
      }
      if (!response.body) {
        throw new VoiceDownloadError({ reason: 'network', source, resource, message: 'Response had no body' })
      }

      if (resumed) {
        await fsCall(resource, () => feedPrefix(part, offset, hash))
        resumedFromBytes = offset
      }
      handle = await fsCall(resource, () => open(part, resumed ? 'a' : 'w'))
      let completed = offset
      report(completed, source, true)

      reader = response.body.getReader()
      let chunkStart = completed
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          armIdle()
          if (completed + value.byteLength > asset.bytes) {
            await removeQuietly(part)
            throw new VoiceDownloadError({
              reason: 'integrity', source, resource,
              message: `Received more than the expected ${asset.bytes} bytes`,
            })
          }
          hash.update(value)
          chunkStart = completed
          await fsCall(resource, () => writeFully(handle!, value))
          completed += value.byteLength
          report(completed, source, false)
        }
      } catch (error) {
        signal?.throwIfAborted()
        // Bun's fetch can append a few bytes of request text to the last chunk when the
        // server resets mid-body. Dropping that chunk keeps the resumed prefix clean.
        await handle.truncate(chunkStart).catch(() => {})
        if (attemptAbort.signal.aborted) {
          throw new VoiceDownloadError({ reason: 'timeout', source, resource, message: 'Transfer stalled' })
        }
        throw toDownloadError(error, { source, resource })
      }

      if (completed < asset.bytes) {
        throw new VoiceDownloadError({
          reason: 'network', source, resource,
          message: `Connection closed after ${completed} of ${asset.bytes} bytes`,
        })
      }

      await handle.close()
      handle = undefined
      if (!digestMatches(hash, asset.hash)) {
        await removeQuietly(part)
        // A bad prefix from an older run is recoverable; a bad fresh download is not.
        if (resumed) return 'restart'
        throw new VoiceDownloadError({
          reason: 'integrity', source, resource,
          message: `${asset.hash.algorithm} mismatch for ${asset.name}`,
        })
      }
      await fsCall(resource, () => rename(part, destination))
      report(asset.bytes, source, true)
      return { source, ...(resumedFromBytes ? { resumedFromBytes } : {}) }
    } finally {
      clearTimeout(idleTimer)
      attemptAbort.abort()
      await reader?.cancel().catch(() => {})
      await handle?.close().catch(() => {})
    }
  }

  /** Retry loop for one URL: a discarded partial file restarts once from zero. */
  const attempt = async (url: string): Promise<DownloadResult> => {
    const first = await transfer(url, true)
    if (first !== 'restart') return first
    const second = await transfer(url, false)
    if (second !== 'restart') return second
    throw new VoiceDownloadError({
      reason: 'integrity', source: sanitizeOrigin(url), resource,
      message: `${asset.hash.algorithm} mismatch for ${asset.name}`,
    })
  }

  const ordered = await orderSources(asset.urls, fetchImpl, resolveOptions, options.probeTimeoutMs ?? 3000, signal)
  let lastError: VoiceDownloadError | undefined
  for (const url of ordered) {
    for (let retry = 0; ; retry++) {
      try {
        return await attempt(url)
      } catch (error) {
        signal?.throwIfAborted()
        const failure = toDownloadError(error, { source: sanitizeOrigin(url), resource })
        lastError = failure
        const reason = failure.failure.reason
        if (isTerminal(reason)) throw failure
        if (!isTransient(reason) || retry >= maxRetries) break
        await sleep(Math.min(backoffMs * 2 ** retry, maxBackoffMs), signal)
      }
    }
  }
  throw lastError ?? new VoiceDownloadError({ reason: 'unknown', resource, message: 'No download source configured' })
}
