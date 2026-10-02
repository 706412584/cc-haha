import { PDFJS_ASSET_FOLDERS, pdfjsAssetsPrefix } from './pdfAssets'
import { PDF_CSS_UNITS, type PageSize } from './pdfLayout'

type Pdfjs = typeof import('pdfjs-dist')
type PdfjsDocument = Awaited<ReturnType<Pdfjs['getDocument']>['promise']>
type PdfjsLoadingTask = ReturnType<Pdfjs['getDocument']>
type PdfjsWorker = InstanceType<Pdfjs['PDFWorker']>

/**
 * Why a PDF could not be shown, in the terms the reader can act on.
 *
 * - `password`: encrypted and needs a password this viewer does not ask for.
 * - `invalid`: not a PDF, damaged, or half-written by an agent that is still at it.
 * - `unavailable`: pdf.js itself could not start here (an old WebView, a blocked worker).
 */
export type PdfErrorKind = 'password' | 'invalid' | 'unavailable'

export class PdfError extends Error {
  readonly kind: PdfErrorKind
  readonly reason: unknown

  constructor(kind: PdfErrorKind, message: string, reason?: unknown) {
    super(message)
    this.name = 'PdfError'
    this.kind = kind
    this.reason = reason
  }
}

export type PdfRenderOptions = {
  canvas: HTMLCanvasElement
  /** Zoom, where 1 is 100%. */
  scale: number
  signal?: AbortSignal
}

export type PdfTextLayerOptions = {
  /** Receives the positioned, transparent text. Cleared first. */
  container: HTMLElement
  scale: number
  signal?: AbortSignal
}

/** An open document. All page numbers are 1-based, as in the PDF. */
export type PdfDocumentHandle = {
  readonly numPages: number
  /** The page's natural size in CSS px at 100%. */
  pageSize(pageNumber: number): Promise<PageSize>
  /** Paint the page into `canvas`, sizing its backing store. Rejects with an `AbortError` if cancelled. */
  renderPage(pageNumber: number, options: PdfRenderOptions): Promise<void>
  /** Build the selectable text of the page. Rejects with an `AbortError` if cancelled. */
  renderTextLayer(pageNumber: number, options: PdfTextLayerOptions): Promise<void>
  /**
   * Free what the engine holds for a page that has scrolled far away. Never throws,
   * and does nothing for a page that does not exist or a document that is closed.
   */
  releasePage(pageNumber: number): void
  destroy(): Promise<void>
}

export type PdfEngine = {
  /** Takes ownership of `data`: pdf.js may transfer (and so detach) its buffer. */
  open(data: Uint8Array): Promise<PdfDocumentHandle>
}

export type PdfEngineOptions = {
  loadPdfjs: () => Promise<Pdfjs>
  /**
   * How to start pdf.js' worker. Omit it to run pdf.js in-thread, which is what
   * Node and the test environment want.
   */
  createWorker?: () => Worker | Promise<Worker>
  /** Folder holding pdf.js' CMaps, fonts and wasm, ending in "/". Omit to use none. */
  assetBaseUrl?: (pdfjs: Pdfjs) => string | undefined
}

/** A device pixel ratio beyond this buys sharpness nobody can see for four times the memory. */
const MAX_DEVICE_PIXEL_RATIO = 2
/** Upper bound on one page canvas's backing store: 16 Mpx is ~64 MB of RGBA. */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024
const WORKER_START_TIMEOUT_MS = 15_000

function abortError(): Error {
  const error = new Error('The PDF render was cancelled')
  error.name = 'AbortError'
  return error
}

function isCancelled(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'RenderingCancelledException'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

/** Turn whatever pdf.js threw while opening into something the panel can word. */
function classifyOpenError(error: unknown): PdfError {
  const name = (error as { name?: string } | null)?.name
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'PasswordException') return new PdfError('password', message, error)
  // Everything else that fails while parsing is, to the reader, a document that cannot be shown.
  return new PdfError('invalid', message, error)
}

/**
 * Start pdf.js' worker and prove it came up.
 *
 * Given a worker port pdf.js does no handshake and has no fallback: a worker
 * whose script fails to load (a syntax error on an old WebView, a blocked URL)
 * leaves every later `getDocument()` waiting forever. So the worker is watched for
 * its first message — pdf.js' own "ready" — or an error, and a dead one becomes an
 * ordinary, reportable failure.
 *
 * What comes back is a `PDFWorker` this engine owns and hands to every document.
 * Left to pdf.js, a document that was given only the port adopts the port's
 * `PDFWorker` and takes it down with itself: while that teardown runs, the next
 * `getDocument()` on the port throws "the worker is being destroyed" — and the app
 * closes a document without waiting exactly when it opens the next, whenever the
 * reader switches files or the file is rewritten.
 */
async function startWorker(pdfjs: Pdfjs, createWorker: () => Worker | Promise<Worker>): Promise<PdfjsWorker> {
  const worker = await createWorker()
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settle(new Error('pdf.js worker did not start in time')), WORKER_START_TIMEOUT_MS)
      const onMessage = () => settle()
      const onError = (event: Event) => settle(new Error((event as ErrorEvent).message || 'pdf.js worker failed to load'))
      const settle = (failure?: Error) => {
        clearTimeout(timer)
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        if (failure) reject(failure)
        else resolve()
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
    })
  } catch (error) {
    worker.terminate()
    throw error
  }
  // `create`, not `new`: pdf.js types the constructor's `port` as null, and `create` is
  // the documented way to build one around a port.
  return pdfjs.PDFWorker.create({ port: worker })
}

class PdfjsDocumentHandle implements PdfDocumentHandle {
  private closed = false

  constructor(
    private readonly pdfjs: Pdfjs,
    private readonly document: PdfjsDocument,
    private readonly task: PdfjsLoadingTask,
  ) {}

  get numPages(): number {
    return this.document.numPages
  }

  async pageSize(pageNumber: number): Promise<PageSize> {
    const page = await this.document.getPage(pageNumber)
    const { width, height } = page.getViewport({ scale: PDF_CSS_UNITS })
    return { width, height }
  }

  async renderPage(pageNumber: number, { canvas, scale, signal }: PdfRenderOptions): Promise<void> {
    throwIfAborted(signal)
    const page = await this.document.getPage(pageNumber)
    throwIfAborted(signal)

    const viewport = page.getViewport({ scale: scale * PDF_CSS_UNITS })
    const output = new this.pdfjs.OutputScale()
    output.sx = Math.min(output.sx, MAX_DEVICE_PIXEL_RATIO)
    output.sy = Math.min(output.sy, MAX_DEVICE_PIXEL_RATIO)
    // Shrinks the backing store, never the on-screen size: a huge page at high zoom
    // gets softer, not an out-of-memory canvas.
    output.limitCanvas(viewport.width, viewport.height, MAX_CANVAS_PIXELS, -1)
    canvas.width = Math.floor(viewport.width * output.sx)
    canvas.height = Math.floor(viewport.height * output.sy)

    const task = page.render({
      canvas,
      viewport,
      transform: output.scaled ? [output.sx, 0, 0, output.sy, 0, 0] : undefined,
    })
    const cancel = () => task.cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      await task.promise
    } catch (error) {
      if (isCancelled(error)) throw abortError()
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  async renderTextLayer(pageNumber: number, { container, scale, signal }: PdfTextLayerOptions): Promise<void> {
    throwIfAborted(signal)
    const page = await this.document.getPage(pageNumber)
    throwIfAborted(signal)

    container.replaceChildren()
    const layer = new this.pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container,
      viewport: page.getViewport({ scale: scale * PDF_CSS_UNITS }),
    })
    const cancel = () => layer.cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      await layer.render()
    } catch (error) {
      if (signal?.aborted || isCancelled(error)) throw abortError()
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
    throwIfAborted(signal)
  }

  releasePage(pageNumber: number): void {
    // Best effort, and never a failure. A page that is already gone has nothing to
    // release, and neither has a document that is closed: when a file is rewritten the
    // new document replaces the old one while its pages are still on screen, and each
    // page hands back its predecessor's page only once the new drawing is up — after
    // the old document was closed. pdf.js then throws from `getPage` outright instead
    // of returning a rejected promise, which no `.catch` on the promise could catch.
    if (this.closed) return
    try {
      void this.document.getPage(pageNumber).then((page) => page.cleanup()).catch(() => undefined)
    } catch {
      // Closed between the check and the call.
    }
  }

  async destroy(): Promise<void> {
    this.closed = true
    await this.task.destroy()
  }
}

/**
 * The PDF engine, built on pdf.js' core API rather than its bundled viewer: the
 * viewer drags in a 6,000-line global stylesheet and expects `globalThis.pdfjsLib`,
 * neither of which belongs in this app. What it would have provided — page layout,
 * lazy rendering, zoom — lives in `pdfLayout.ts` and `PdfSurface`.
 */
export function createPdfEngine(options: PdfEngineOptions): PdfEngine {
  let ready: Promise<{ pdfjs: Pdfjs; worker: PdfjsWorker | undefined }> | null = null

  const start = async () => {
    try {
      const pdfjs = await options.loadPdfjs()
      const worker = options.createWorker ? await startWorker(pdfjs, options.createWorker) : undefined
      return { pdfjs, worker }
    } catch (error) {
      throw new PdfError('unavailable', error instanceof Error ? error.message : String(error), error)
    }
  }

  return {
    async open(data) {
      // Memoised so concurrent opens share one worker, but not a failure: an engine
      // that could not start is worth trying again on the next document.
      ready ??= start().catch((error: unknown) => {
        ready = null
        throw error
      })
      const { pdfjs, worker } = await ready
      const base = options.assetBaseUrl?.(pdfjs)
      const task = pdfjs.getDocument({
        data,
        enableXfa: false,
        // Errors only. pdf.js narrates every font it substitutes at the default level.
        verbosity: 0,
        // Ours, so a document being closed does not take it down (see startWorker).
        ...(worker ? { worker } : {}),
        ...(base
          ? {
              cMapUrl: `${base}${PDFJS_ASSET_FOLDERS.cMapUrl}/`,
              cMapPacked: true,
              standardFontDataUrl: `${base}${PDFJS_ASSET_FOLDERS.standardFontDataUrl}/`,
              wasmUrl: `${base}${PDFJS_ASSET_FOLDERS.wasmUrl}/`,
              iccUrl: `${base}${PDFJS_ASSET_FOLDERS.iccUrl}/`,
            }
          : {}),
      })
      try {
        return new PdfjsDocumentHandle(pdfjs, await task.promise, task)
      } catch (error) {
        await task.destroy().catch(() => undefined)
        throw classifyOpenError(error)
      }
    },
  }
}

/**
 * The engine the app uses. pdf.js and its worker load on the first document, not
 * at startup. The asset folder is emitted next to the app by `vite-pdfjs-assets`,
 * named for the installed version so an upgrade cannot leave stale data behind.
 */
export const defaultPdfEngine: PdfEngine = createPdfEngine({
  loadPdfjs: () => import('pdfjs-dist/legacy/build/pdf.mjs'),
  createWorker: async () => {
    const { default: PdfWorker } = await import('./pdf.worker?worker')
    return new PdfWorker()
  },
  assetBaseUrl: (pdfjs) => new URL(`./${pdfjsAssetsPrefix(pdfjs.version)}`, document.baseURI).href,
})
