// @vitest-environment node
/**
 * The engine against the real pdf.js, in Node, on documents built in the test.
 * There is no canvas here, so painting is left to the browser smoke; what this
 * proves is the part a mock cannot: that the import path, the getDocument
 * options and the error mapping actually work with the shipped library.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { letterPdf, pdfWithPages } from '@/test/fixtures/pdf'
import { PdfError, createPdfEngine, type PdfDocumentHandle, type PdfEngine } from './pdfEngine'
import { PDF_CSS_UNITS } from './pdfLayout'

const engine: PdfEngine = createPdfEngine({ loadPdfjs: () => import('pdfjs-dist/legacy/build/pdf.mjs') })
const open: PdfDocumentHandle[] = []

async function openPdf(data: Uint8Array): Promise<PdfDocumentHandle> {
  const handle = await engine.open(data)
  open.push(handle)
  return handle
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.destroy()))
})

describe('pdfEngine with the real pdf.js', () => {
  it('opens a document and reports its page count', async () => {
    const handle = await openPdf(letterPdf(3))

    expect(handle.numPages).toBe(3)
  })

  it('reports each page at its own natural size, in CSS pixels at 100%', async () => {
    const handle = await openPdf(pdfWithPages([
      { width: 612, height: 792, text: 'portrait' },
      { width: 792, height: 612, text: 'landscape' },
    ]))

    // PDF points to CSS pixels: ×96/72 — so a Letter page is 816 × 1056.
    expect(await handle.pageSize(1)).toEqual({ width: 612 * PDF_CSS_UNITS, height: 792 * PDF_CSS_UNITS })
    expect(await handle.pageSize(2)).toEqual({ width: 792 * PDF_CSS_UNITS, height: 612 * PDF_CSS_UNITS })
  })

  it('can open several documents from one engine, one after another', async () => {
    const first = await openPdf(letterPdf(2))
    const second = await openPdf(letterPdf(5))

    expect(first.numPages).toBe(2)
    expect(second.numPages).toBe(5)
  })

  it('answers garbage with an `invalid` error rather than a raw pdf.js exception', async () => {
    const failure = await engine.open(new TextEncoder().encode('this is not a pdf at all')).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PdfError)
    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('answers a file cut off mid-write (an agent still at it) as `invalid`, not as a hang', async () => {
    const whole = letterPdf(2)
    const truncated = whole.slice(0, Math.floor(whole.length / 2))

    const failure = await engine.open(truncated).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('answers an empty file as `invalid`', async () => {
    const failure = await engine.open(new Uint8Array(0)).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('refuses to paint into a page that has been cancelled before it began', async () => {
    const handle = await openPdf(letterPdf(1))
    const controller = new AbortController()
    controller.abort()

    await expect(
      handle.renderPage(1, { canvas: {} as HTMLCanvasElement, scale: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(
      handle.renderTextLayer(1, { container: {} as HTMLElement, scale: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not throw when asked to release a page that does not exist', async () => {
    const handle = await openPdf(letterPdf(1))

    expect(() => handle.releasePage(99)).not.toThrow()
  })

  it('does not throw when asked to release a page of a document that has been closed', async () => {
    // A rewritten file replaces the document while its pages are still on screen. Each
    // page hands back its predecessor's page once the new drawing is up, by which time
    // the old document is closed — and pdf.js throws from `getPage` on a closed
    // document, synchronously, rather than rejecting.
    const handle = await engine.open(letterPdf(2))
    await handle.destroy()

    expect(() => handle.releasePage(1)).not.toThrow()
  })

  it('does not throw for a page that was never drawn either, once the document is closed', async () => {
    const handle = await engine.open(letterPdf(3))
    await handle.destroy()

    for (const page of [1, 2, 3, 99]) expect(() => handle.releasePage(page)).not.toThrow()
  })
})

/**
 * pdf.js run through a worker port has no handshake and no fallback: a worker
 * whose script never loads leaves every later document waiting forever. So the
 * engine watches the worker itself. These use a stand-in pdf.js, since what is
 * under test is the watching, not the parsing.
 */
describe('pdfEngine worker startup', () => {
  class FakeWorker extends EventTarget {
    terminate = vi.fn()
    postMessage = vi.fn()
    /**
     * Settles once the engine is watching this worker. Events sent before that are
     * lost, as they would be for a real worker, and counting microtask ticks to
     * guess when the engine gets there is how tests like this go flaky.
     */
    readonly watched: Promise<void>
    private markWatched!: () => void

    constructor() {
      super()
      this.watched = new Promise<void>((resolve) => { this.markWatched = resolve })
    }

    override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
      super.addEventListener(type, listener, options)
      if (type === 'error') this.markWatched()
    }
  }

  function stubPdfjs() {
    const document = { numPages: 1 }
    const task = { promise: Promise.resolve(document), destroy: vi.fn().mockResolvedValue(undefined) }
    // Every `PDFWorker` the engine builds, and the port it was built over.
    const workers: Array<{ params: { port: unknown } }> = []
    class PDFWorker {
      static create(params: { port: unknown }) {
        return new PDFWorker(params)
      }

      constructor(readonly params: { port: unknown }) {
        workers.push(this)
      }
    }
    return {
      pdfjs: {
        version: '0.0.0',
        PDFWorker,
        getDocument: vi.fn((_params: Record<string, unknown>) => task),
      },
      task,
      workers,
    }
  }

  const engineWith = (stub: ReturnType<typeof stubPdfjs>, createWorker: () => FakeWorker | Promise<FakeWorker>) =>
    createPdfEngine({
      loadPdfjs: async () => stub.pdfjs as unknown as typeof import('pdfjs-dist'),
      createWorker: createWorker as unknown as () => Worker,
    })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('goes ahead once the worker says anything, and hands pdf.js a PDFWorker over that worker', async () => {
    const stub = stubPdfjs()
    const worker = new FakeWorker()
    const pending = engineWith(stub, () => worker).open(new Uint8Array(1))

    // The worker's first message is pdf.js' own "ready".
    await worker.watched
    worker.dispatchEvent(new Event('message'))
    const handle = await pending
    open.push(handle)

    expect(stub.workers).toHaveLength(1)
    expect(stub.workers[0]!.params.port).toBe(worker)
    expect(stub.pdfjs.getDocument).toHaveBeenCalledTimes(1)
    expect(stub.pdfjs.getDocument.mock.calls[0]![0]).toMatchObject({ worker: stub.workers[0] })
  })

  it('reports a worker whose script fails to load as `unavailable`, and stops it', async () => {
    const stub = stubPdfjs()
    const worker = new FakeWorker()
    const pending = engineWith(stub, () => worker).open(new Uint8Array(1))

    await worker.watched
    const event = new Event('error') as Event & { message?: string }
    event.message = 'SyntaxError: Unexpected token {'
    worker.dispatchEvent(event)

    await expect(pending).rejects.toMatchObject({ kind: 'unavailable', message: 'SyntaxError: Unexpected token {' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    // A dead worker must not be left as the port every later document is sent to.
    expect(stub.workers).toHaveLength(0)
    expect(stub.pdfjs.getDocument).not.toHaveBeenCalled()
  })

  it('gives up on a worker that never answers instead of waiting forever', async () => {
    vi.useFakeTimers()
    const stub = stubPdfjs()
    const worker = new FakeWorker()
    const pending = engineWith(stub, () => worker).open(new Uint8Array(1))
    const outcome = pending.catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(15_000)

    expect(await outcome).toMatchObject({ kind: 'unavailable', message: 'pdf.js worker did not start in time' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh worker for the next document after one failed to start', async () => {
    const stub = stubPdfjs()
    const workers: FakeWorker[] = []
    const engine = engineWith(stub, () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })

    const first = engine.open(new Uint8Array(1)).catch((error: unknown) => error)
    await vi.waitFor(() => expect(workers).toHaveLength(1))
    await workers[0]!.watched
    workers[0]!.dispatchEvent(new Event('error'))
    expect(await first).toMatchObject({ kind: 'unavailable' })

    const second = engine.open(new Uint8Array(1))
    await vi.waitFor(() => expect(workers).toHaveLength(2))
    await workers[1]!.watched
    workers[1]!.dispatchEvent(new Event('message'))
    open.push(await second)

    expect(stub.workers).toHaveLength(1)
    expect(stub.workers[0]!.params.port).toBe(workers[1])
  })

  it('shares one worker between documents opened together, and keeps it for the ones opened later', async () => {
    const stub = stubPdfjs()
    const worker = new FakeWorker()
    const createWorker = vi.fn(() => worker)
    const engine = engineWith(stub, createWorker)

    const both = Promise.all([engine.open(new Uint8Array(1)), engine.open(new Uint8Array(1))])
    await worker.watched
    worker.dispatchEvent(new Event('message'))
    open.push(...(await both))
    open.push(await engine.open(new Uint8Array(1)))

    expect(createWorker).toHaveBeenCalledTimes(1)
    expect(stub.workers).toHaveLength(1)
    // Every document is given the engine's own PDFWorker. Handed only the port, pdf.js
    // would give each document a worker of its own to tear down with it.
    expect(stub.pdfjs.getDocument.mock.calls.map(([params]) => params.worker)).toEqual([
      stub.workers[0],
      stub.workers[0],
      stub.workers[0],
    ])
  })

  it('does not start a worker when none is configured, which is how tests and Node run', async () => {
    const stub = stubPdfjs()

    const handle = await createPdfEngine({
      loadPdfjs: async () => stub.pdfjs as unknown as typeof import('pdfjs-dist'),
    }).open(new Uint8Array(1))
    open.push(handle)

    expect(stub.workers).toHaveLength(0)
    expect(stub.pdfjs.getDocument.mock.calls[0]![0]).not.toHaveProperty('worker')
  })
})

/**
 * The engine through a worker port, against the real pdf.js on both ends. The worker
 * half runs in this thread at the far end of a MessageChannel; what is under test is
 * how pdf.js treats the port on the main side, and that is the same for a Worker.
 */
describe('pdfEngine through a worker port, with the real pdf.js', () => {
  const channels: Array<InstanceType<typeof import('node:worker_threads').MessageChannel>> = []
  const handles: PdfDocumentHandle[] = []

  async function engineOverChannel(): Promise<PdfEngine> {
    const { MessageChannel } = await import('node:worker_threads')
    const { WorkerMessageHandler } = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    const channel = new MessageChannel()
    channels.push(channel)
    WorkerMessageHandler.initializeFromPort(channel.port2)
    return createPdfEngine({
      loadPdfjs: () => import('pdfjs-dist/legacy/build/pdf.mjs'),
      createWorker: () => Object.assign(channel.port1, { terminate: () => channel.port1.close() }) as unknown as Worker,
    })
  }

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.destroy().catch(() => undefined)))
    for (const channel of channels.splice(0)) {
      channel.port1.close()
      channel.port2.close()
    }
  })

  it('opens a document over the port', async () => {
    const engine = await engineOverChannel()

    const handle = await engine.open(letterPdf(3))
    handles.push(handle)

    expect(handle.numPages).toBe(3)
    expect(await handle.pageSize(1)).toEqual({ width: 612 * PDF_CSS_UNITS, height: 792 * PDF_CSS_UNITS })
  })

  it('opens the next document straight after closing one, without waiting for the close', async () => {
    // Switching files closes the document on screen and opens the next in the same
    // breath, and the close is not awaited: React cannot await an effect's cleanup.
    // With only the port to go on, pdf.js tore its worker down with the closing
    // document, and the next `getDocument()` threw "the worker is being destroyed".
    const engine = await engineOverChannel()
    const first = await engine.open(letterPdf(2))
    const second = await engine.open(letterPdf(3))
    handles.push(second)

    void first.destroy()
    const third = await engine.open(letterPdf(4))
    handles.push(third)

    expect(third.numPages).toBe(4)
  })

  it('opens documents on top of one another as fast as a file is rewritten', async () => {
    const engine = await engineOverChannel()
    let previous = await engine.open(letterPdf(1))

    for (let version = 2; version <= 8; version += 1) {
      const next = engine.open(letterPdf(version))
      void previous.destroy()
      previous = await next
    }
    handles.push(previous)

    expect(previous.numPages).toBe(8)
  })

  it('still opens a document after the last one was closed', async () => {
    const engine = await engineOverChannel()
    await (await engine.open(letterPdf(1))).destroy()

    const handle = await engine.open(letterPdf(2))
    handles.push(handle)

    expect(handle.numPages).toBe(2)
  })
})

describe('pdfEngine startup', () => {
  it('reports pdf.js failing to load as `unavailable`, not as a broken document', async () => {
    const broken = createPdfEngine({ loadPdfjs: () => Promise.reject(new Error('module blocked')) })

    const failure = await broken.open(letterPdf(1)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PdfError)
    expect(failure).toMatchObject({ kind: 'unavailable', message: 'module blocked' })
  })

  it('tries again after a failed start instead of caching the failure for the session', async () => {
    let attempts = 0
    const flaky = createPdfEngine({
      loadPdfjs: () => {
        attempts += 1
        return attempts === 1 ? Promise.reject(new Error('offline')) : import('pdfjs-dist/legacy/build/pdf.mjs')
      },
    })

    await expect(flaky.open(letterPdf(1))).rejects.toMatchObject({ kind: 'unavailable' })
    const handle = await flaky.open(letterPdf(1))
    open.push(handle)

    expect(handle.numPages).toBe(1)
    expect(attempts).toBe(2)
  })

  it('starts the library once for concurrent documents', async () => {
    const loadPdfjs = vi.fn(() => import('pdfjs-dist/legacy/build/pdf.mjs'))
    const shared = createPdfEngine({ loadPdfjs })

    const [a, b] = await Promise.all([shared.open(letterPdf(1)), shared.open(letterPdf(2))])
    open.push(a, b)

    expect(loadPdfjs).toHaveBeenCalledTimes(1)
  })
})
