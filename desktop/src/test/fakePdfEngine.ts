import { vi } from 'vitest'
import type { PdfDocumentHandle, PdfEngine } from '@/components/workspace/surfaces/document/pdfEngine'
import { PDF_CSS_UNITS, type PageSize } from '@/components/workspace/surfaces/document/pdfLayout'

/** A page as the reader sees it at 100%: Letter, in CSS pixels. */
export const LETTER: PageSize = { width: 612 * PDF_CSS_UNITS, height: 792 * PDF_CSS_UNITS }

/** One `renderPage` call in flight, for a test to finish or fail when it chooses. */
export type FakeRender = {
  pageNumber: number
  scale: number
  canvas: HTMLCanvasElement
  signal: AbortSignal | undefined
  finish: () => void
  fail: (error: unknown) => void
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

export type FakePdfDocument = PdfDocumentHandle & {
  renders: FakeRender[]
  /** Renders that have started and been neither finished nor cancelled. */
  pending: () => FakeRender[]
}

/**
 * A PDF document a test can drive. Painting never completes by itself: a test
 * decides when each page finishes, which is what lets it assert on the state in
 * between (the previous drawing still on screen, a render that was cancelled).
 * Pass `autoFinish` for the tests that only care about what ends up drawn.
 */
export function createFakePdfDocument({
  pages = 3,
  sizes,
  autoFinish = false,
}: { pages?: number; sizes?: PageSize[]; autoFinish?: boolean } = {}): FakePdfDocument {
  const pageSizes = sizes ?? Array.from({ length: pages }, () => LETTER)
  const renders: FakeRender[] = []
  const cancelled = new WeakSet<FakeRender>()
  const finished = new WeakSet<FakeRender>()

  const handle: FakePdfDocument = {
    numPages: pageSizes.length,
    renders,
    pending: () => renders.filter((render) => !finished.has(render) && !cancelled.has(render)),
    pageSize: vi.fn(async (pageNumber: number) => pageSizes[pageNumber - 1]!),
    renderPage: vi.fn((pageNumber, { canvas, scale, signal }) => new Promise<void>((resolve, reject) => {
      const render: FakeRender = {
        pageNumber,
        scale,
        canvas,
        signal,
        finish: () => {
          finished.add(render)
          canvas.width = 100
          canvas.height = 100
          resolve()
        },
        fail: (error) => {
          finished.add(render)
          reject(error)
        },
      }
      signal?.addEventListener('abort', () => {
        cancelled.add(render)
        reject(abortError())
      }, { once: true })
      renders.push(render)
      if (autoFinish) render.finish()
    })),
    renderTextLayer: vi.fn(async (pageNumber, { container, signal }) => {
      if (signal?.aborted) throw abortError()
      const span = document.createElement('span')
      span.textContent = `text of page ${pageNumber}`
      container.replaceChildren(span)
    }),
    releasePage: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  return handle
}

/**
 * An engine whose `open` calls a test settles by hand, in any order: what it takes
 * to reproduce a file being rewritten while the previous version is still opening.
 */
export function createControllablePdfEngine() {
  const opens: Array<{
    data: Uint8Array
    resolve: (doc: PdfDocumentHandle) => void
    reject: (reason: unknown) => void
  }> = []
  const engine: PdfEngine = {
    open: vi.fn((data: Uint8Array) => new Promise<PdfDocumentHandle>((resolve, reject) => {
      opens.push({ data, resolve, reject })
    })),
  }
  return { engine, opens }
}

/** An engine that opens whatever it is given as `document`, or fails with `failure`. */
export function createFakePdfEngine(
  document: PdfDocumentHandle | (() => PdfDocumentHandle),
  failure?: unknown,
): PdfEngine & { open: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(async () => {
      if (failure) throw failure
      return typeof document === 'function' ? document() : document
    }),
  }
}
