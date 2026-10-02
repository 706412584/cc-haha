import { useCallback, useEffect, useState } from 'react'
import { PdfError, type PdfDocumentHandle, type PdfEngine } from './pdfEngine'
import type { PageSize } from './pdfLayout'

/** A document that is open, with every page's natural size (so the column can be laid out at once). */
export type OpenPdf = {
  doc: PdfDocumentHandle
  sizes: PageSize[]
}

export type PdfDocumentState = {
  /**
   * The document to show. It stays in place while a newer version of the same file
   * opens, and is only replaced once the new one is ready.
   */
  current: OpenPdf | null
  /**
   * Why the newest version could not be opened. With `current` set, that is the
   * previous version, still on screen; without, there is nothing to show.
   */
  error: PdfError | null
  retry: () => void
}

function toPdfError(reason: unknown): PdfError {
  if (reason instanceof PdfError) return reason
  return new PdfError('invalid', reason instanceof Error ? reason.message : String(reason), reason)
}

function close(doc: PdfDocumentHandle | null): void {
  void doc?.destroy().catch(() => undefined)
}

/**
 * Open the PDF in `blob` with `engine`, and keep it open for as long as it is shown.
 *
 * A file that an agent is still writing produces a stream of versions, some of them
 * half a PDF. Each new `blob` is opened off to the side: the reader keeps the
 * version they are looking at until the next one is fully open, and a version that
 * will not open changes nothing but the note under the page.
 */
export function usePdfDocument(engine: PdfEngine, blob: Blob): PdfDocumentState {
  const [current, setCurrent] = useState<OpenPdf | null>(null)
  const [error, setError] = useState<PdfError | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let superseded = false
    setError(null)

    void (async () => {
      let opened: PdfDocumentHandle | null = null
      try {
        // Our own copy: pdf.js transfers the buffer it is given to its worker, and
        // the Blob is still needed for the next tab switch.
        const document = await engine.open(new Uint8Array(await blob.arrayBuffer()))
        opened = document
        if (superseded) return close(document)
        if (document.numPages < 1) throw new PdfError('invalid', 'The PDF has no pages')

        const sizes = await Promise.all(Array.from({ length: document.numPages }, (_, index) => document.pageSize(index + 1)))
        if (superseded) return close(document)
        setCurrent({ doc: document, sizes })
      } catch (reason) {
        close(opened)
        if (!superseded) setError(toPdfError(reason))
      }
    })()

    return () => {
      superseded = true
    }
  }, [engine, blob, attempt])

  // The document on screen is closed when it is replaced or the viewer goes away.
  // After the commit that swaps it out, so pages still drawing from it are cancelled first.
  useEffect(() => {
    if (!current) return
    return () => close(current.doc)
  }, [current])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  return { current, error, retry }
}
