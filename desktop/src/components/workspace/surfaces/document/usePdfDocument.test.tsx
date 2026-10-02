import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { blobWithBytes } from '@/test/blobs'
import {
  LETTER,
  createControllablePdfEngine,
  createFakePdfDocument,
  type FakePdfDocument,
} from '@/test/fakePdfEngine'
import { PdfError, type PdfEngine } from './pdfEngine'
import { usePdfDocument } from './usePdfDocument'

const bytes = (...values: number[]) => blobWithBytes(values, 'application/pdf')

/**
 * The blob is made once, outside the render: the cache hands a viewer the same
 * Blob for as long as the version is the same, and a hook handed a new one on every
 * render would (correctly) open the document again on every render.
 */
function mount(engine: PdfEngine, blob = bytes(1)) {
  return renderHook(() => usePdfDocument(engine, blob))
}

describe('usePdfDocument', () => {
  it('has nothing to show until the document is open', async () => {
    const { engine, opens } = createControllablePdfEngine()

    const { result } = mount(engine)

    await waitFor(() => expect(opens).toHaveLength(1))
    expect(result.current.current).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('opens the bytes of the blob and lays out every page from its own size', async () => {
    const { engine, opens } = createControllablePdfEngine()
    const doc = createFakePdfDocument({
      sizes: [LETTER, { width: 500, height: 700 }, { width: 900, height: 600 }],
    })

    const { result } = mount(engine, bytes(37, 80, 68, 70))
    await waitFor(() => expect(opens).toHaveLength(1))
    expect(Array.from(opens[0]!.data)).toEqual([37, 80, 68, 70])
    await act(async () => opens[0]!.resolve(doc))

    await waitFor(() => expect(result.current.current).not.toBeNull())
    expect(result.current.current!.doc).toBe(doc)
    expect(result.current.current!.sizes).toEqual([LETTER, { width: 500, height: 700 }, { width: 900, height: 600 }])
    expect(doc.pageSize).toHaveBeenCalledTimes(3)
  })

  it('gives the engine a copy of the bytes: pdf.js detaches what it is given, and the blob is opened again later', async () => {
    const opened: Uint8Array[] = []
    const engine: PdfEngine = {
      open: vi.fn(async (data: Uint8Array) => {
        opened.push(Uint8Array.from(data))
        data.fill(0) // as a transfer to the worker would leave it
        return createFakePdfDocument({ pages: 1 })
      }),
    }
    const blob = bytes(1, 2, 3)

    const first = renderHook(() => usePdfDocument(engine, blob))
    await waitFor(() => expect(first.result.current.current).not.toBeNull())
    first.unmount()
    const second = renderHook(() => usePdfDocument(engine, blob))
    await waitFor(() => expect(second.result.current.current).not.toBeNull())

    expect(opened.map((data) => Array.from(data))).toEqual([[1, 2, 3], [1, 2, 3]])
  })

  describe('when it cannot be opened', () => {
    it('reports why, in the engine’s own terms', async () => {
      const { engine, opens } = createControllablePdfEngine()
      const { result } = mount(engine)
      await waitFor(() => expect(opens).toHaveLength(1))

      await act(async () => opens[0]!.reject(new PdfError('password', 'No password given')))

      await waitFor(() => expect(result.current.error).not.toBeNull())
      expect(result.current.error!.kind).toBe('password')
      expect(result.current.current).toBeNull()
    })

    it('calls anything else that goes wrong a document that cannot be shown', async () => {
      const { engine, opens } = createControllablePdfEngine()
      const { result } = mount(engine)
      await waitFor(() => expect(opens).toHaveLength(1))

      await act(async () => opens[0]!.reject(new TypeError('boom')))

      await waitFor(() => expect(result.current.error?.kind).toBe('invalid'))
    })

    it('closes a document whose pages cannot be measured instead of leaking it', async () => {
      const { engine, opens } = createControllablePdfEngine()
      const doc = createFakePdfDocument({ pages: 2 })
      vi.mocked(doc.pageSize).mockRejectedValue(new Error('Invalid page request'))
      const { result } = mount(engine)
      await waitFor(() => expect(opens).toHaveLength(1))

      await act(async () => opens[0]!.resolve(doc))

      await waitFor(() => expect(result.current.error?.kind).toBe('invalid'))
      expect(doc.destroy).toHaveBeenCalledTimes(1)
      expect(result.current.current).toBeNull()
    })

    it('does not accept a document with no pages', async () => {
      const { engine, opens } = createControllablePdfEngine()
      const doc = createFakePdfDocument({ pages: 0 })
      const { result } = mount(engine)
      await waitFor(() => expect(opens).toHaveLength(1))

      await act(async () => opens[0]!.resolve(doc))

      await waitFor(() => expect(result.current.error?.kind).toBe('invalid'))
      expect(doc.destroy).toHaveBeenCalledTimes(1)
    })

    it('tries again on request, and clears the failure when it works', async () => {
      const { engine, opens } = createControllablePdfEngine()
      const { result } = mount(engine)
      await waitFor(() => expect(opens).toHaveLength(1))
      await act(async () => opens[0]!.reject(new PdfError('unavailable', 'worker did not start')))
      await waitFor(() => expect(result.current.error?.kind).toBe('unavailable'))

      act(() => result.current.retry())
      await waitFor(() => expect(opens).toHaveLength(2))
      expect(result.current.error).toBeNull() // no longer showing the last attempt's failure
      await act(async () => opens[1]!.resolve(createFakePdfDocument({ pages: 1 })))

      await waitFor(() => expect(result.current.current).not.toBeNull())
      expect(result.current.error).toBeNull()
    })
  })

  describe('when the file is rewritten', () => {
    async function shown() {
      const { engine, opens } = createControllablePdfEngine()
      const first = createFakePdfDocument({ pages: 3 })
      const hook = renderHook(({ blob }) => usePdfDocument(engine, blob), { initialProps: { blob: bytes(1) } })
      await waitFor(() => expect(opens).toHaveLength(1))
      await act(async () => opens[0]!.resolve(first))
      await waitFor(() => expect(hook.result.current.current?.doc).toBe(first))
      return { ...hook, engine, opens, first }
    }

    it('keeps showing the version the reader is looking at until the next one is open', async () => {
      const { result, rerender, opens, first } = await shown()

      rerender({ blob: bytes(2) })
      await waitFor(() => expect(opens).toHaveLength(2))

      expect(result.current.current!.doc).toBe(first)
      expect(first.destroy).not.toHaveBeenCalled()
    })

    it('swaps to the new version when it is ready, and only then closes the old one', async () => {
      const { result, rerender, opens, first } = await shown()
      const second = createFakePdfDocument({ pages: 5 })

      rerender({ blob: bytes(2) })
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.resolve(second))

      await waitFor(() => expect(result.current.current!.doc).toBe(second))
      expect(result.current.current!.sizes).toHaveLength(5)
      await waitFor(() => expect(first.destroy).toHaveBeenCalledTimes(1))
      expect(second.destroy).not.toHaveBeenCalled()
    })

    it('keeps the previous version, and says why, when the new one will not open', async () => {
      const { result, rerender, opens, first } = await shown()

      rerender({ blob: bytes(2) }) // a half-written PDF
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.reject(new PdfError('invalid', 'Invalid PDF structure.')))

      await waitFor(() => expect(result.current.error?.kind).toBe('invalid'))
      expect(result.current.current!.doc).toBe(first)
      expect(first.destroy).not.toHaveBeenCalled()
    })

    it('drops the note about a failed version as soon as a good one arrives', async () => {
      const { result, rerender, opens } = await shown()
      rerender({ blob: bytes(2) })
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.reject(new PdfError('invalid', 'Invalid PDF structure.')))
      await waitFor(() => expect(result.current.error).not.toBeNull())

      rerender({ blob: bytes(3) })
      await waitFor(() => expect(opens).toHaveLength(3))
      await act(async () => opens[2]!.resolve(createFakePdfDocument({ pages: 2 })))

      await waitFor(() => expect(result.current.current!.sizes).toHaveLength(2))
      expect(result.current.error).toBeNull()
    })

    it('never shows a version that was overtaken while it was still opening', async () => {
      const { result, rerender, opens, first } = await shown()
      const slow = createFakePdfDocument({ pages: 4 })
      const fast = createFakePdfDocument({ pages: 6 })

      rerender({ blob: bytes(2) })
      await waitFor(() => expect(opens).toHaveLength(2))
      rerender({ blob: bytes(3) })
      await waitFor(() => expect(opens).toHaveLength(3))
      await act(async () => opens[2]!.resolve(fast)) // the newer version finishes first
      await waitFor(() => expect(result.current.current!.doc).toBe(fast))
      await act(async () => opens[1]!.resolve(slow)) // the older one limps in afterwards

      await waitFor(() => expect(slow.destroy).toHaveBeenCalledTimes(1))
      expect(result.current.current!.doc).toBe(fast)
      expect(fast.destroy).not.toHaveBeenCalled()
      expect(first.destroy).toHaveBeenCalledTimes(1)
    })

    it('drops a version overtaken after it opened but while its pages were still being measured', async () => {
      const { result, rerender, opens, first } = await shown()
      const measuring = createFakePdfDocument({ pages: 2 })
      const finishMeasuring: Array<() => void> = []
      vi.mocked(measuring.pageSize).mockImplementation(
        () => new Promise((resolve) => finishMeasuring.push(() => resolve(LETTER))),
      )

      rerender({ blob: bytes(2) })
      await waitFor(() => expect(opens).toHaveLength(2))
      await act(async () => opens[1]!.resolve(measuring))
      await waitFor(() => expect(finishMeasuring).toHaveLength(2))
      rerender({ blob: bytes(3) }) // overtaken mid-measure
      await waitFor(() => expect(opens).toHaveLength(3))
      await act(async () => finishMeasuring.forEach((finish) => finish()))

      await waitFor(() => expect(measuring.destroy).toHaveBeenCalledTimes(1))
      expect(result.current.current!.doc).toBe(first)
    })

    it('does not report the failure of a version that was overtaken', async () => {
      const { result, rerender, opens } = await shown()
      rerender({ blob: bytes(2) })
      await waitFor(() => expect(opens).toHaveLength(2))
      rerender({ blob: bytes(3) })
      await waitFor(() => expect(opens).toHaveLength(3))

      await act(async () => opens[1]!.reject(new PdfError('invalid', 'stale')))

      expect(result.current.error).toBeNull()
    })
  })

  describe('when the viewer goes away', () => {
    it('closes the document on screen', async () => {
      const { engine, opens } = createControllablePdfEngine()
      const doc: FakePdfDocument = createFakePdfDocument({ pages: 2 })
      const { result, unmount } = mount(engine)
      await waitFor(() => expect(opens).toHaveLength(1))
      await act(async () => opens[0]!.resolve(doc))
      await waitFor(() => expect(result.current.current).not.toBeNull())

      unmount()

      expect(doc.destroy).toHaveBeenCalledTimes(1)
    })

    it('closes a document that finishes opening after it left', async () => {
      const { engine, opens } = createControllablePdfEngine()
      const doc = createFakePdfDocument({ pages: 2 })
      const { unmount } = mount(engine)
      await waitFor(() => expect(opens).toHaveLength(1))

      unmount()
      await act(async () => opens[0]!.resolve(doc))

      await waitFor(() => expect(doc.destroy).toHaveBeenCalledTimes(1))
    })

    it('does not close a document twice', async () => {
      const { engine, opens } = createControllablePdfEngine()
      const doc = createFakePdfDocument({ pages: 2 })
      const { result, unmount, rerender } = renderHook(({ blob }) => usePdfDocument(engine, blob), {
        initialProps: { blob: bytes(1) },
      })
      await waitFor(() => expect(opens).toHaveLength(1))
      await act(async () => opens[0]!.resolve(doc))
      await waitFor(() => expect(result.current.current).not.toBeNull())

      rerender({ blob: bytes(2) })
      unmount()

      expect(doc.destroy).toHaveBeenCalledTimes(1)
    })
  })
})
