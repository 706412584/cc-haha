import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  documentBlobKey,
  fetchDocumentBlob,
  forgetDocumentBlobs,
  peekDocumentBlob,
  resetDocumentBlobCacheForTests,
} from './documentBlobCache'

const MIB = 1024 * 1024

function blobOfSize(size: number, label = 'x'): Blob {
  const blob = new Blob([label])
  // The cache only reads `size`; faking it avoids allocating real megabytes.
  Object.defineProperty(blob, 'size', { value: size })
  return blob
}

type Deferred = {
  promise: Promise<Blob>
  resolve: (blob: Blob) => void
  reject: (error: unknown) => void
  signal: AbortSignal | null
}

/** A loader whose completion the test controls, and which honours its abort signal. */
function controlledLoader() {
  const calls: Deferred[] = []
  const load = vi.fn((signal: AbortSignal) => {
    let resolve!: (blob: Blob) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<Blob>((res, rej) => {
      resolve = res
      reject = rej
    })
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    calls.push({ promise, resolve, reject, signal })
    return promise
  })
  return { load, calls }
}

beforeEach(() => resetDocumentBlobCacheForTests())
afterEach(() => resetDocumentBlobCacheForTests())

describe('documentBlobCache', () => {
  it('serves a fetched revision from memory without asking the loader again', async () => {
    const loader = vi.fn(async () => blobOfSize(10))

    const first = await fetchDocumentBlob('s', 'a.pdf', 'v1', loader)
    const second = await fetchDocumentBlob('s', 'a.pdf', 'v1', loader)

    expect(second).toBe(first)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(peekDocumentBlob(documentBlobKey('s', 'a.pdf', 'v1'))).toBe(first)
  })

  it('treats a new version as a different document and drops the old revision at once', async () => {
    await fetchDocumentBlob('s', 'a.pdf', 'v1', async () => blobOfSize(10))
    const v2 = await fetchDocumentBlob('s', 'a.pdf', 'v2', async () => blobOfSize(20))

    expect(peekDocumentBlob(documentBlobKey('s', 'a.pdf', 'v1'))).toBeUndefined()
    expect(peekDocumentBlob(documentBlobKey('s', 'a.pdf', 'v2'))).toBe(v2)
  })

  it('keeps at most three files, evicting the least recently used', async () => {
    for (const name of ['a', 'b', 'c']) {
      await fetchDocumentBlob('s', `${name}.pdf`, 'v', async () => blobOfSize(1))
    }
    // Touching `a` makes `b` the least recently used.
    peekDocumentBlob(documentBlobKey('s', 'a.pdf', 'v'))
    await fetchDocumentBlob('s', 'd.pdf', 'v', async () => blobOfSize(1))

    expect(peekDocumentBlob(documentBlobKey('s', 'b.pdf', 'v'))).toBeUndefined()
    for (const name of ['a', 'c', 'd']) {
      expect(peekDocumentBlob(documentBlobKey('s', `${name}.pdf`, 'v'))).toBeDefined()
    }
  })

  it('evicts by total size, not only by count', async () => {
    await fetchDocumentBlob('s', 'a.pdf', 'v', async () => blobOfSize(100 * MIB))
    await fetchDocumentBlob('s', 'b.pdf', 'v', async () => blobOfSize(100 * MIB))

    expect(peekDocumentBlob(documentBlobKey('s', 'a.pdf', 'v'))).toBeUndefined()
    expect(peekDocumentBlob(documentBlobKey('s', 'b.pdf', 'v'))).toBeDefined()
  })

  it('returns a blob larger than the whole budget without caching it', async () => {
    const huge = blobOfSize(500 * MIB)

    await expect(fetchDocumentBlob('s', 'huge.pdf', 'v', async () => huge)).resolves.toBe(huge)

    expect(peekDocumentBlob(documentBlobKey('s', 'huge.pdf', 'v'))).toBeUndefined()
  })

  it('does not cache a failure, so the next request tries again', async () => {
    const failing = vi.fn(async () => { throw new Error('boom') })
    const succeeding = vi.fn(async () => blobOfSize(1))

    await expect(fetchDocumentBlob('s', 'a.pdf', 'v', failing)).rejects.toThrow('boom')
    await expect(fetchDocumentBlob('s', 'a.pdf', 'v', succeeding)).resolves.toBeInstanceOf(Blob)

    expect(succeeding).toHaveBeenCalledTimes(1)
  })

  it('reports a loader that throws synchronously as a rejection', async () => {
    const throwing = vi.fn((): Promise<Blob> => { throw new Error('sync boom') })

    await expect(fetchDocumentBlob('s', 'a.pdf', 'v', throwing)).rejects.toThrow('sync boom')
  })

  it('shares one request between concurrent viewers of the same revision', async () => {
    const { load, calls } = controlledLoader()

    const first = fetchDocumentBlob('s', 'a.pdf', 'v', load)
    const second = fetchDocumentBlob('s', 'a.pdf', 'v', load)
    const blob = blobOfSize(5)
    calls[0]!.resolve(blob)

    expect(await first).toBe(blob)
    expect(await second).toBe(blob)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('cancels the request only when the last interested viewer has gone', async () => {
    const { load, calls } = controlledLoader()
    const first = new AbortController()
    const second = new AbortController()

    const firstResult = fetchDocumentBlob('s', 'a.pdf', 'v', load, first.signal)
    const secondResult = fetchDocumentBlob('s', 'a.pdf', 'v', load, second.signal)
    const firstOutcome = firstResult.catch((error: Error) => error.name)
    const secondOutcome = secondResult.catch((error: Error) => error.name)

    first.abort()
    expect(await firstOutcome).toBe('AbortError')
    // Another tab still wants these bytes: the download must go on.
    expect(calls[0]!.signal!.aborted).toBe(false)

    second.abort()
    expect(await secondOutcome).toBe('AbortError')
    expect(calls[0]!.signal!.aborted).toBe(true)
  })

  it('lets a viewer that arrives after a cancelled request start a fresh one', async () => {
    const { load, calls } = controlledLoader()
    const controller = new AbortController()
    const cancelled = fetchDocumentBlob('s', 'a.pdf', 'v', load, controller.signal).catch(() => 'aborted')
    controller.abort()
    await cancelled

    const retried = fetchDocumentBlob('s', 'a.pdf', 'v', load)
    const blob = blobOfSize(3)
    calls[1]!.resolve(blob)

    expect(await retried).toBe(blob)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache the result of a request that was cancelled while in flight', async () => {
    const loader = vi.fn(
      (signal: AbortSignal) => new Promise<Blob>((resolve) => {
        // Ignores the signal, as a loader might: it still completes after the abort.
        setTimeout(() => resolve(blobOfSize(1)), 0)
        void signal
      }),
    )
    const controller = new AbortController()
    const outcome = fetchDocumentBlob('s', 'a.pdf', 'v', loader, controller.signal).catch(() => 'aborted')
    controller.abort()
    await outcome
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(peekDocumentBlob(documentBlobKey('s', 'a.pdf', 'v'))).toBeUndefined()
  })

  it('rejects immediately for a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const loader = vi.fn(async () => blobOfSize(1))

    await expect(fetchDocumentBlob('s', 'a.pdf', 'v', loader, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(loader).not.toHaveBeenCalled()
  })

  it('forgets one file or a whole session', async () => {
    await fetchDocumentBlob('s1', 'a.pdf', 'v', async () => blobOfSize(1))
    await fetchDocumentBlob('s1', 'b.pdf', 'v', async () => blobOfSize(1))
    await fetchDocumentBlob('s2', 'a.pdf', 'v', async () => blobOfSize(1))

    forgetDocumentBlobs('s1', 'a.pdf')
    expect(peekDocumentBlob(documentBlobKey('s1', 'a.pdf', 'v'))).toBeUndefined()
    expect(peekDocumentBlob(documentBlobKey('s1', 'b.pdf', 'v'))).toBeDefined()

    forgetDocumentBlobs('s1')
    expect(peekDocumentBlob(documentBlobKey('s1', 'b.pdf', 'v'))).toBeUndefined()
    expect(peekDocumentBlob(documentBlobKey('s2', 'a.pdf', 'v'))).toBeDefined()
  })
})
