import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakePdfDocument, type FakePdfDocument } from '@/test/fakePdfEngine'
import { expectSameNodes } from '@/test/nodes'
import { useSettingsStore } from '@/stores/settingsStore'
import { PdfPage, type PdfPageProps } from './PdfPage'
import { PDF_CSS_UNITS } from './pdfLayout'

let doc: FakePdfDocument

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  doc = createFakePdfDocument({ pages: 12 })
})

function page(overrides: Partial<PdfPageProps> = {}) {
  return <PdfPage doc={doc} pageNumber={3} total={12} scale={1} drawScale={1} {...overrides} />
}

const frame = () => screen.getByRole('group', { name: 'Page 3 of 12' })
const canvases = () => Array.from(frame().querySelectorAll('canvas'))
const textLayer = () => frame().querySelector('.textLayer')

/**
 * What `pdfPage.css` declares for `element`: every rule whose selector matches it.
 * jsdom lays nothing out, so this is how a test can tell that the stylesheet and the
 * elements the component builds still meet — a selector written for a different
 * nesting simply stops applying, and the page renders at twice its size.
 */
function declaredFor(element: Element): Map<string, string> {
  const css = readFileSync(path.join(import.meta.dirname, 'pdfPage.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const declared = new Map<string, string>()
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const applies = selectors!.split(',').some((selector) => {
      try {
        return element.matches(selector.trim())
      } catch {
        return false // a pseudo-element, or half a selector list split at a comma inside :is()
      }
    })
    if (!applies) continue
    for (const declaration of body!.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon > 0) declared.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim())
    }
  }
  return declared
}

/** Let a document's `index`-th render finish and its result be swapped onto the sheet. */
async function drawn(index = 0, on: FakePdfDocument = doc) {
  await waitFor(() => expect(on.renders.length).toBeGreaterThan(index))
  await act(async () => on.renders[index]!.finish())
  await waitFor(() => expect(canvases().length).toBe(1))
}

describe('PdfPage', () => {
  it('is named for the reader by its place in the document', () => {
    render(page())

    expect(frame()).toBeInTheDocument()
  })

  it('draws the page it is, at the zoom it is told to draw at', async () => {
    render(page({ pageNumber: 3, drawScale: 1.5 }))

    await waitFor(() => expect(doc.renderPage).toHaveBeenCalledTimes(1))
    expect(doc.renderPage).toHaveBeenCalledWith(3, expect.objectContaining({ scale: 1.5 }))
    expect(doc.renderTextLayer).not.toHaveBeenCalled() // only once the bitmap is done
  })

  it('puts the canvas and its selectable text on the page once both are ready', async () => {
    render(page())
    expect(canvases()).toHaveLength(0)

    await drawn()

    expect(canvases()).toHaveLength(1)
    expect(textLayer()).toHaveTextContent('text of page 3')
    // Keeps a drag selection from collapsing at the last span.
    expect(textLayer()!.querySelector('.endOfContent')).not.toBeNull()
  })

  describe('its stylesheet', () => {
    it('shrinks the canvas to the size of the sheet, however many pixels pdf.js drew it with', async () => {
      render(page())
      await drawn()

      // pdf.js draws at up to twice the pixels for a dense screen. Without this rule the
      // canvas shows at its own pixel size and the sheet shows only its top-left quarter.
      const style = declaredFor(canvases()[0]!)
      expect(style.get('position')).toBe('absolute')
      expect(style.get('width')).toBe('100%')
      expect(style.get('height')).toBe('100%')
    })

    it('lays the selectable text exactly over the canvas', async () => {
      render(page())
      await drawn()

      const style = declaredFor(textLayer()!)
      expect(style.get('position')).toBe('absolute')
      expect(style.get('inset')).toBe('0')
      expect(style.get('overflow')).toBe('clip')
    })

    it('keeps the drag-selection sentinel below the text and out of the way of the pointer', async () => {
      render(page())
      await drawn()

      const style = declaredFor(textLayer()!.querySelector('.endOfContent')!)
      expect(style.get('position')).toBe('absolute')
      expect(style.get('user-select')).toBe('none')
    })

    it('makes the sheet the containing block for both, and the paper white', () => {
      render(page({ }))

      const style = declaredFor(frame())
      expect(style.get('position')).toBe('relative')
      expect(style.get('overflow')).toBe('hidden')
      expect(style.get('background')).toBe('var(--color-document-paper)')
    })
  })

  describe('redrawing at another zoom', () => {
    it('keeps the previous drawing on screen until the new one is ready, so the page never flashes blank', async () => {
      const { rerender } = render(page({ drawScale: 1 }))
      await drawn(0)
      const before = canvases()[0]!

      rerender(page({ drawScale: 2 }))
      await waitFor(() => expect(doc.renders.length).toBe(2))

      expectSameNodes(canvases(), [before])
      expect(before.width).toBeGreaterThan(0)

      await act(async () => doc.renders[1]!.finish())
      await waitFor(() => expect(canvases()[0]).not.toBe(before))
      expect(canvases()).toHaveLength(1)
    })

    it('gives the replaced bitmap back at once instead of leaving it to the collector', async () => {
      const { rerender } = render(page({ drawScale: 1 }))
      await drawn(0)
      const before = canvases()[0]!

      rerender(page({ drawScale: 2 }))
      await waitFor(() => expect(doc.renders.length).toBe(2))
      await act(async () => doc.renders[1]!.finish())
      await waitFor(() => expect(canvases()[0]).not.toBe(before))

      expect(before.width).toBe(0)
      expect(before.height).toBe(0)
    })

    it('cancels the draw it supersedes and does not swap its result in', async () => {
      const { rerender } = render(page({ drawScale: 1 }))
      await waitFor(() => expect(doc.renders.length).toBe(1))
      const superseded = doc.renders[0]!

      rerender(page({ drawScale: 2 }))

      expect(superseded.signal!.aborted).toBe(true)
      await waitFor(() => expect(doc.renders.length).toBe(2))
      await act(async () => doc.renders[1]!.finish())
      await waitFor(() => expect(canvases()).toHaveLength(1))
      expect(canvases()[0]).toBe(doc.renders[1]!.canvas)
    })

    it('does not treat a cancelled draw as a failure', async () => {
      const { rerender } = render(page({ drawScale: 1 }))
      await waitFor(() => expect(doc.renders.length).toBe(1))

      rerender(page({ drawScale: 2 }))
      await waitFor(() => expect(doc.renders.length).toBe(2))

      expect(screen.queryByText('This page could not be drawn.')).not.toBeInTheDocument()
    })

    it('does not release a page that is still on screen: it is being redrawn, not dropped', async () => {
      const { rerender } = render(page({ drawScale: 1 }))
      await drawn(0)

      rerender(page({ drawScale: 2 }))
      await waitFor(() => expect(doc.renders.length).toBe(2))
      await act(async () => doc.renders[1]!.finish())
      await waitFor(() => expect(canvases()[0]).toBe(doc.renders[1]!.canvas))

      expect(doc.releasePage).not.toHaveBeenCalled()
    })
  })

  it('sizes the sheet from the live zoom while the bitmap still waits for the settled one', () => {
    // The text layer scales itself from this variable, so it follows a gesture
    // without waiting for the page to be redrawn.
    render(page({ scale: 1.5, drawScale: 1 }))

    expect(frame().style.getPropertyValue('--scale-factor')).toBe(String(1.5 * PDF_CSS_UNITS))
  })

  describe('when the document is replaced (the file was rewritten)', () => {
    it('keeps the previous drawing until the new document’s page is ready', async () => {
      const { rerender } = render(page())
      await drawn(0)
      const before = canvases()[0]!
      const next = createFakePdfDocument({ pages: 12 })

      rerender(page({ doc: next }))
      await waitFor(() => expect(next.renders.length).toBe(1))

      // Not blank: the reader is still looking at the old version.
      expectSameNodes(canvases(), [before])
      expect(before.width).toBeGreaterThan(0)

      await act(async () => next.renders[0]!.finish())
      await waitFor(() => expect(canvases()[0]).toBe(next.renders[0]!.canvas))
      expect(canvases()).toHaveLength(1)
    })

    it('lets the old document release its page once the new drawing has replaced it, and only then', async () => {
      const { rerender } = render(page())
      await drawn(0)
      const next = createFakePdfDocument({ pages: 12 })

      rerender(page({ doc: next }))
      await waitFor(() => expect(next.renders.length).toBe(1))
      expect(doc.releasePage).not.toHaveBeenCalled()

      await act(async () => next.renders[0]!.finish())
      await waitFor(() => expect(doc.releasePage).toHaveBeenCalledWith(3))
      expect(next.releasePage).not.toHaveBeenCalled()
    })

    it('does not let a failure handing back the old document’s page undo the drawing that replaced it', async () => {
      // The old document is closed by then, and a closed pdf.js document throws when asked
      // for a page. That is tidying up after a good drawing, not a failed drawing: the
      // canvas the reader is looking at must keep its pixels, and no error appears on the sheet.
      const { rerender } = render(page())
      await drawn(0)
      vi.mocked(doc.releasePage).mockImplementation(() => {
        throw new TypeError("Cannot read properties of null (reading 'sendWithPromise')")
      })
      const next = createFakePdfDocument({ pages: 12 })

      rerender(page({ doc: next }))
      await waitFor(() => expect(next.renders.length).toBe(1))
      await act(async () => next.renders[0]!.finish())
      await waitFor(() => expect(canvases()[0]).toBe(next.renders[0]!.canvas))

      expect(next.renders[0]!.canvas.width).toBeGreaterThan(0)
      expect(textLayer()).toHaveTextContent('text of page 3')
      expect(screen.queryByText('This page could not be drawn.')).not.toBeInTheDocument()
    })

    it('cancels the draw still running against the old document', async () => {
      const { rerender } = render(page())
      await waitFor(() => expect(doc.renders.length).toBe(1))
      const inFlight = doc.renders[0]!

      rerender(page({ doc: createFakePdfDocument({ pages: 12 }) }))

      expect(inFlight.signal!.aborted).toBe(true)
    })
  })

  describe('memory', () => {
    it('gives its bitmap back and asks pdf.js to release the page when it unmounts', async () => {
      const { unmount } = render(page())
      await drawn()
      const canvas = canvases()[0]!

      unmount()

      expect(canvas.width).toBe(0)
      expect(canvas.height).toBe(0)
      expect(doc.releasePage).toHaveBeenCalledTimes(1)
      expect(doc.releasePage).toHaveBeenCalledWith(3)
    })

    it('cancels a draw still in flight when it unmounts', async () => {
      const { unmount } = render(page())
      await waitFor(() => expect(doc.renders.length).toBe(1))

      unmount()

      expect(doc.renders[0]!.signal!.aborted).toBe(true)
    })

    it('does not ask pdf.js to release a page that never finished drawing: releasing parses it', async () => {
      const { unmount } = render(page())
      await waitFor(() => expect(doc.renders.length).toBe(1))

      unmount()

      expect(doc.releasePage).not.toHaveBeenCalled()
    })

    it('nor one that failed to draw', async () => {
      const { unmount } = render(page())
      await waitFor(() => expect(doc.renders.length).toBe(1))
      await act(async () => doc.renders[0]!.fail(new Error('bad glyph')))
      await screen.findByText('This page could not be drawn.')

      unmount()

      expect(doc.releasePage).not.toHaveBeenCalled()
    })
  })

  describe('when the page cannot be drawn', () => {
    it('says so on the sheet, in the reader’s language', async () => {
      render(page())
      await waitFor(() => expect(doc.renders.length).toBe(1))

      await act(async () => doc.renders[0]!.fail(new Error('bad glyph')))

      expect(await screen.findByText('This page could not be drawn.')).toBeInTheDocument()
    })

    it('leaves the previous drawing in place when only the redraw failed', async () => {
      const { rerender } = render(page({ drawScale: 1 }))
      await drawn(0)
      const before = canvases()[0]!

      rerender(page({ drawScale: 2 }))
      await waitFor(() => expect(doc.renders.length).toBe(2))
      await act(async () => doc.renders[1]!.fail(new Error('out of memory')))

      expectSameNodes(canvases(), [before])
      expect(await screen.findByText('This page could not be drawn.')).toBeInTheDocument()
    })

    it('recovers when a later draw succeeds', async () => {
      const { rerender } = render(page({ drawScale: 1 }))
      await waitFor(() => expect(doc.renders.length).toBe(1))
      await act(async () => doc.renders[0]!.fail(new Error('transient')))
      await screen.findByText('This page could not be drawn.')

      rerender(page({ drawScale: 2 }))
      await waitFor(() => expect(doc.renders.length).toBe(2))
      await act(async () => doc.renders[1]!.finish())

      await waitFor(() => expect(screen.queryByText('This page could not be drawn.')).not.toBeInTheDocument())
      expect(canvases()).toHaveLength(1)
    })
  })

  describe('selecting text', () => {
    it('marks the text layer as selecting while the mouse is down, and clears it on release anywhere', async () => {
      render(page())
      await drawn()

      fireEvent.mouseDown(textLayer()!)
      expect(textLayer()).toHaveClass('selecting')

      fireEvent.mouseUp(window)
      expect(textLayer()).not.toHaveClass('selecting')
    })

    it('stops listening for the release once it unmounts', async () => {
      const { unmount } = render(page())
      await drawn()

      unmount()

      // Would throw on the detached text layer if the listener were still attached.
      expect(() => fireEvent.mouseUp(window)).not.toThrow()
    })
  })
})
