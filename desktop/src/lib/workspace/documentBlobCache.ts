/**
 * Fetched document bytes, kept across tab switches.
 *
 * The workspace mounts only the active tab, so a viewer that owned its own
 * download would fetch and re-parse a 30 MiB file every time the user flips to
 * another tab and back. Blobs are cheap to hold — the browser is free to back
 * them with disk — and, unlike an `ArrayBuffer`, are not consumed by the engine
 * that reads them: pdf.js transfers the buffer it is given to its worker, which
 * detaches it. So the cache holds the Blob and every consumer takes its own
 * `arrayBuffer()`.
 *
 * Entries are keyed by the file's version, so an agent rewriting the file is a
 * different key, not a stale hit; a newer version of the same file replaces the
 * older one immediately rather than waiting to be evicted.
 */

const MAX_ENTRIES = 3
const MAX_BYTES = 192 * 1024 * 1024

type CacheEntry = { base: string; key: string; blob: Blob }

type InFlight = {
  promise: Promise<Blob>
  controller: AbortController
  subscribers: number
}

/** Least recently used first. */
let entries: CacheEntry[] = []
const inFlight = new Map<string, InFlight>()

export function documentBlobKey(sessionId: string, path: string, version: string): string {
  return `${sessionId}::${path}@${version}`
}

/** Everything in a key before its version: identifies the file, not the revision. */
function baseOf(sessionId: string, path: string): string {
  return `${sessionId}::${path}@`
}

/** A held Blob for exactly this revision, or undefined. Marks it recently used. */
export function peekDocumentBlob(key: string): Blob | undefined {
  const index = entries.findIndex((entry) => entry.key === key)
  if (index === -1) return undefined
  const [entry] = entries.splice(index, 1)
  entries.push(entry!)
  return entry!.blob
}

function store(sessionId: string, path: string, key: string, blob: Blob): void {
  const base = baseOf(sessionId, path)
  // A newer revision of the same file makes every older one dead weight.
  entries = entries.filter((entry) => entry.base !== base && entry.key !== key)
  if (blob.size > MAX_BYTES) return
  entries.push({ base, key, blob })
  while (
    entries.length > MAX_ENTRIES
    || entries.reduce((total, entry) => total + entry.blob.size, 0) > MAX_BYTES
  ) {
    entries.shift()
  }
}

/**
 * Load a document once per revision, however many viewers ask.
 *
 * Concurrent callers for the same key share one request. Each brings its own
 * abort signal; the request is cancelled only when the last interested caller
 * has gone, so one tab unmounting cannot cancel a download another still wants.
 */
export function fetchDocumentBlob(
  sessionId: string,
  path: string,
  version: string,
  load: (signal: AbortSignal) => Promise<Blob>,
  signal?: AbortSignal,
): Promise<Blob> {
  const key = documentBlobKey(sessionId, path, version)
  const cached = peekDocumentBlob(key)
  if (cached) return Promise.resolve(cached)
  if (signal?.aborted) return Promise.reject(abortError())

  let request = inFlight.get(key)
  if (!request) {
    const controller = new AbortController()
    const created: InFlight = {
      controller,
      subscribers: 0,
      // Constructed, not called directly, so a loader that throws synchronously
      // is a rejection like any other failure rather than an escape from here.
      promise: new Promise<Blob>((resolve) => resolve(load(controller.signal))).then(
        (blob) => {
          // A request cancelled after its last subscriber left must not repopulate
          // the cache with a revision nobody asked for.
          if (inFlight.get(key) === created) {
            inFlight.delete(key)
            store(sessionId, path, key, blob)
          }
          return blob
        },
        (error: unknown) => {
          if (inFlight.get(key) === created) inFlight.delete(key)
          throw error
        },
      ),
    }
    inFlight.set(key, created)
    request = created
  }

  const shared = request
  shared.subscribers += 1
  return new Promise<Blob>((resolve, reject) => {
    let settled = false
    const release = () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      if (settled) return
      release()
      shared.subscribers -= 1
      if (shared.subscribers <= 0 && inFlight.get(key) === shared) {
        inFlight.delete(key)
        shared.controller.abort()
      }
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    shared.promise.then(
      (blob) => {
        if (settled) return
        release()
        shared.subscribers -= 1
        resolve(blob)
      },
      (error: unknown) => {
        if (settled) return
        release()
        shared.subscribers -= 1
        reject(error)
      },
    )
  })
}

function abortError(): Error {
  const error = new Error('The document request was aborted')
  error.name = 'AbortError'
  return error
}

/** Drop every held revision of one file (the file was deleted or the session closed). */
export function forgetDocumentBlobs(sessionId: string, path?: string): void {
  const prefix = path === undefined ? `${sessionId}::` : baseOf(sessionId, path)
  entries = entries.filter((entry) => !entry.key.startsWith(prefix))
}

/** Test seam: the cache is module state shared by every viewer. */
export function resetDocumentBlobCacheForTests(): void {
  entries = []
  for (const request of inFlight.values()) request.controller.abort()
  inFlight.clear()
}
