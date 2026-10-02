import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { DocxError, type DocxEngine } from './docxEngine'
import {
  attachFrameListeners,
  createDocxFrame,
  currentColorScheme,
  documentPaperColor,
  naturalPageWidth,
  neutraliseLinks,
  presentationCss,
  type FrameHandlers,
} from './docxFrame'

/** A Word document drawn into its frame. The frame is already in the page; the viewer sizes it. */
export type RenderedDocx = {
  frame: HTMLIFrameElement
  doc: Document
  /** The widest page at 100%, in CSS pixels. */
  naturalWidth: number
}

type Drawn = RenderedDocx & { detach: () => void }

export type DocxDocumentState = {
  /**
   * The document to show. It stays in place while a newer version of the same file is
   * drawn, and is only replaced once the new one is complete.
   */
  current: RenderedDocx | null
  /**
   * Why the newest version could not be drawn. With `current` set, that is the previous
   * version, still on screen; without, there is nothing to show.
   */
  error: DocxError | null
  retry: () => void
}

/** Keep a frame out of sight and out of the layout while it is drawn. */
function hide(frame: HTMLIFrameElement): void {
  frame.style.position = 'absolute'
  frame.style.top = '0'
  frame.style.left = '0'
  frame.style.visibility = 'hidden'
  frame.style.pointerEvents = 'none'
}

function reveal(frame: HTMLIFrameElement): void {
  for (const property of ['position', 'top', 'left', 'visibility', 'pointer-events']) frame.style.removeProperty(property)
}

function toDocxError(reason: unknown): DocxError {
  if (reason instanceof DocxError) return reason
  return new DocxError('invalid', reason instanceof Error ? reason.message : String(reason), reason)
}

/**
 * Draw the Word document in `blob` into a frame under `hostRef`, and keep it there for as
 * long as it is shown.
 *
 * A file an agent is still writing produces a stream of versions, some of them half a
 * document. Each new `blob` is drawn in a frame off to the side; the reader keeps the
 * version they are looking at until the next one is complete, and one that will not draw
 * changes nothing but the note under the page.
 *
 * `layoutRef` sizes a frame — its zoom, its width, its height. It is called before a new frame
 * is put on show, so that the swap does not pass through a frame with no height.
 */
export function useDocxDocument({
  engine,
  blob,
  hostRef,
  title,
  handlersRef,
  layoutRef,
}: {
  engine: DocxEngine
  blob: Blob
  hostRef: RefObject<HTMLElement | null>
  title: string
  handlersRef: MutableRefObject<FrameHandlers>
  layoutRef: MutableRefObject<(rendered: RenderedDocx) => void>
}): DocxDocumentState {
  const [current, setCurrent] = useState<RenderedDocx | null>(null)
  const [error, setError] = useState<DocxError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const onShow = useRef<Drawn | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let superseded = false
    setError(null)

    void (async () => {
      let drawn: Drawn | null = null
      const discard = () => {
        drawn?.detach()
        drawn?.frame.remove()
      }
      let frame: HTMLIFrameElement | null = null
      try {
        // Our own copy of the bytes: the Blob is held for the next tab switch.
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (superseded) return

        const created = createDocxFrame(host, currentColorScheme())
        frame = created.frame
        frame.title = title
        // While another version is on show, draw the next where it cannot be seen.
        if (onShow.current) hide(frame)
        const doc = await created.ready
        if (superseded) return frame.remove()

        // Three siblings, in this order: docx-preview's stylesheet is written into the first
        // (it empties whatever it is given), the pages into the second, and ours goes last so
        // that it wins over docx-preview's where the two say the same thing.
        const styles = doc.createElement('div')
        const pages = doc.createElement('div')
        const presentation = doc.createElement('style')
        presentation.textContent = presentationCss(documentPaperColor())
        doc.body.append(styles, pages, presentation)

        await engine.render(bytes, { body: pages, styles })
        if (superseded) return frame.remove()

        neutraliseLinks(pages)
        const detach = attachFrameListeners(doc, {
          onExternalLink: (url) => handlersRef.current.onExternalLink(url),
          onWheelZoom: (deltaY, at) => handlersRef.current.onWheelZoom(deltaY, at),
          onZoomKey: (key) => handlersRef.current.onZoomKey(key),
        })
        drawn = { frame, doc, naturalWidth: naturalPageWidth(doc), detach }

        // Size it, then swap. The frame is complete and correctly sized before anyone sees it.
        layoutRef.current(drawn)
        const previous = onShow.current
        reveal(frame)
        previous?.detach()
        previous?.frame.remove()
        onShow.current = drawn
        setCurrent({ frame: drawn.frame, doc: drawn.doc, naturalWidth: drawn.naturalWidth })
      } catch (reason) {
        discard()
        frame?.remove()
        if (!superseded) setError(toDocxError(reason))
      }
    })()

    return () => {
      superseded = true
    }
  }, [engine, blob, attempt, hostRef, title, handlersRef, layoutRef])

  // Whatever is on show goes when the viewer does.
  useEffect(() => () => {
    onShow.current?.detach()
    onShow.current = null
  }, [])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  return { current, error, retry }
}
