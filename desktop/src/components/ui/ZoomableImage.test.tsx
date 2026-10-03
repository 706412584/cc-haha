import '@testing-library/jest-dom/vitest'
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOUBLE_PRESS_MS } from '@/lib/zoomPan'
import { ZoomableImage, type ZoomableImageProps } from './ZoomableImage'

const LABELS = { group: 'Zoom controls', zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit to window' }

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
const originalNaturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth')
const originalNaturalHeight = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalHeight')

/** jsdom lays nothing out: give the scroll area and the picture real sizes. */
function stubGeometry({ container = [800, 600], natural = [1600, 1200] }: { container?: [number, number]; natural?: [number, number] } = {}) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => container[0] })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => container[1] })
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => natural[0] })
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => natural[1] })
}

function restore(property: string, target: object, original: PropertyDescriptor | undefined) {
  if (original) Object.defineProperty(target, property, original)
  else Reflect.deleteProperty(target, property)
}

function renderImage(overrides: Partial<ZoomableImageProps> = {}) {
  const view = render(<ZoomableImage src="data:image/png;base64,AAAA" alt="figure.png" labels={LABELS} {...overrides} />)
  const image = screen.getByRole('img', { name: 'figure.png' }) as HTMLImageElement
  // The picture finishing its load is what gives the viewer its natural size.
  act(() => { fireEvent.load(image) })
  return { ...view, image, area: screen.getByRole('group', { name: 'figure.png' }) }
}

/**
 * jsdom has no `PointerEvent`, so `fireEvent.pointerDown(node, { clientX })` drops
 * the coordinates and the button. Build the event and pin the fields — including
 * the time, which is what decides whether two presses are a double click.
 */
function press(node: Element, { time, at = [100, 100], button = 0 }: { time: number; at?: [number, number]; button?: number }) {
  const event = createEvent.pointerDown(node)
  Object.defineProperty(event, 'button', { value: button })
  Object.defineProperty(event, 'clientX', { value: at[0] })
  Object.defineProperty(event, 'clientY', { value: at[1] })
  Object.defineProperty(event, 'timeStamp', { value: time })
  fireEvent(node, event)
}

beforeEach(() => stubGeometry())

afterEach(() => {
  vi.unstubAllGlobals()
  restore('clientWidth', HTMLElement.prototype, originalClientWidth)
  restore('clientHeight', HTMLElement.prototype, originalClientHeight)
  restore('naturalWidth', HTMLImageElement.prototype, originalNaturalWidth)
  restore('naturalHeight', HTMLImageElement.prototype, originalNaturalHeight)
})

describe('ZoomableImage', () => {
  it('starts fitted: the whole picture is visible inside the padded scroll area', () => {
    const { image } = renderImage()

    // 800×600 area, 16px padding each side → 768×568 available; 1600×1200 → min(0.48, 0.4733)
    expect(image.style.width).toBe(`${1600 * (568 / 1200)}px`)
    expect(screen.getByText('47%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fit to window' })).toBeDisabled()
  })

  it('does not enlarge a small picture beyond 100% when fitting', () => {
    stubGeometry({ natural: [200, 100] })
    const { image } = renderImage()

    expect(image.style.width).toBe('200px')
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('steps to the next rung with + and back with −, leaving fit mode', () => {
    const { image } = renderImage()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(image.style.width).toBe('800px')
    expect(screen.getByRole('button', { name: 'Fit to window' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByText('33%')).toBeInTheDocument()
  })

  it('returns to fit from a chosen zoom', () => {
    renderImage()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }))

    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('toggles between fit and 100% on a double click', () => {
    const { area } = renderImage()

    press(area, { time: 1000 })
    press(area, { time: 1150 })
    expect(screen.getByText('100%')).toBeInTheDocument()

    press(area, { time: 3000 })
    press(area, { time: 3150 })
    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('takes the press after a double click as the start of a new one, not a third click', () => {
    const { area } = renderImage()

    press(area, { time: 1000 })
    press(area, { time: 1100 })
    press(area, { time: 1200 })

    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('does not take the trailing half of a double click that opened the viewer for its own', () => {
    // The first click was on a thumbnail, and opened this viewer under the pointer.
    // The surface sees one press, then a `dblclick` that only names it as the target.
    const { area } = renderImage()

    press(area, { time: 1000 })
    fireEvent.doubleClick(area)

    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('needs the second press to follow the first closely, in time and in place', () => {
    const { area } = renderImage()

    press(area, { time: 1000 })
    press(area, { time: 1000 + DOUBLE_PRESS_MS + 1 })
    press(area, { time: 1100 + DOUBLE_PRESS_MS + 1, at: [300, 300] })

    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('leaves the other buttons to the browser', () => {
    const { area } = renderImage()

    press(area, { time: 1000, button: 2 })
    press(area, { time: 1100, button: 2 })

    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('zooms with Ctrl+wheel (also how a trackpad pinch arrives) and lets a plain wheel scroll', () => {
    const { area } = renderImage()

    fireEvent.wheel(area, { deltaY: 120 })
    expect(screen.getByText('47%')).toBeInTheDocument()

    fireEvent.wheel(area, { deltaY: -100, ctrlKey: true })
    expect(Number.parseInt(screen.getByText(/%$/).textContent ?? '0', 10)).toBeGreaterThan(47)
  })

  it('cancels the page-level zoom that a Ctrl+wheel would otherwise trigger', () => {
    // The listener must be native and non-passive for preventDefault to count.
    const { area } = renderImage()
    const event = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })

    act(() => { area.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(true)
  })

  it('does not cancel an ordinary wheel, which must keep scrolling', () => {
    const { area } = renderImage()
    const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })

    act(() => { area.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(false)
  })

  it('handles + - 0 1 from the keyboard', () => {
    const { area } = renderImage()

    fireEvent.keyDown(area, { key: '+' })
    expect(screen.getByText('50%')).toBeInTheDocument()
    fireEvent.keyDown(area, { key: '1' })
    expect(screen.getByText('100%')).toBeInTheDocument()
    fireEvent.keyDown(area, { key: '-' })
    expect(screen.getByText('90%')).toBeInTheDocument()
    fireEvent.keyDown(area, { key: '0' })
    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('leaves shortcuts with a modifier to the browser', () => {
    const { area } = renderImage()

    fireEvent.keyDown(area, { key: '+', ctrlKey: true })
    fireEvent.keyDown(area, { key: '0', metaKey: true })

    expect(screen.getByText('47%')).toBeInTheDocument()
  })

  it('stops zooming out at the smallest and in at the largest zoom', () => {
    const { rerender } = renderImage({ zoom: 0.1 })
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()

    rerender(<ZoomableImage src="data:image/png;base64,AAAA" alt="figure.png" labels={LABELS} zoom={8} />)
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
  })

  describe('controlled zoom', () => {
    it('shows the zoom it is given and reports a request without applying it itself', () => {
      const onZoomChange = vi.fn()
      const { image } = renderImage({ zoom: 1, onZoomChange })
      expect(image.style.width).toBe('1600px')

      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

      expect(onZoomChange).toHaveBeenCalledWith(1.1)
      // The parent owns the value: nothing changes until it passes a new one.
      expect(image.style.width).toBe('1600px')
    })

    it('reports fit as the string "fit"', () => {
      const onZoomChange = vi.fn()
      renderImage({ zoom: 2, onZoomChange })

      fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }))

      expect(onZoomChange).toHaveBeenCalledWith('fit')
    })
  })

  it('renders the extra actions beside the zoom cluster', () => {
    renderImage({ actions: <button type="button">Open in system app</button> })

    expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
  })

  it('reports a picture that fails to load', () => {
    const onError = vi.fn()
    const { image } = renderImage({ onError })

    fireEvent.error(image)

    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('falls back to CSS containment until the picture has a size, instead of guessing', () => {
    // Before load nothing can be measured; forcing a width then would be a guess.
    render(<ZoomableImage src="data:image/png;base64,AAAA" alt="figure.png" labels={LABELS} />)
    const image = screen.getByRole('img', { name: 'figure.png' })

    expect(image.style.width).toBe('')
    expect(image.className).toContain('max-w-full')
  })

  it('keeps the scroll surface marker the workspace uses to restore scroll position', () => {
    const { area } = renderImage()

    expect(area).toHaveAttribute('data-workspace-scroll-surface')
  })

  it('draws a picture that reports no size by CSS containment, not as a 0×0 nothing', () => {
    // An SVG that has only a viewBox has no natural size in some engines.
    stubGeometry({ natural: [0, 0] })
    const { image } = renderImage()

    expect(image.style.width).toBe('')
    expect(image.className).toContain('max-w-full')
  })

  describe('restoring where the reader left it', () => {
    const LEFT_AT = { left: 120, top: 80 }

    function renderUnloaded(overrides: Partial<ZoomableImageProps> = {}) {
      const view = render(<ZoomableImage src="data:image/png;base64,AAAA" alt="figure.png" labels={LABELS} {...overrides} />)
      return {
        ...view,
        image: screen.getByRole('img', { name: 'figure.png' }) as HTMLImageElement,
        area: screen.getByRole('group', { name: 'figure.png' }),
      }
    }

    it('scrolls there once the picture is laid out, not before: until then there is nothing to scroll', () => {
      const { image, area } = renderUnloaded({ zoom: 2, initialScroll: LEFT_AT })
      expect(area.scrollLeft).toBe(0)
      expect(area.scrollTop).toBe(0)

      act(() => { fireEvent.load(image) })

      expect(area.scrollLeft).toBe(LEFT_AT.left)
      expect(area.scrollTop).toBe(LEFT_AT.top)
    })

    it('does it once, and leaves the reader\'s own scrolling alone', () => {
      const { image, area, rerender } = renderUnloaded({ zoom: 2, initialScroll: LEFT_AT })
      act(() => { fireEvent.load(image) })
      area.scrollLeft = 5

      rerender(<ZoomableImage src="data:image/png;base64,AAAA" alt="figure.png" labels={LABELS} zoom={2} initialScroll={{ ...LEFT_AT }} />)

      expect(area.scrollLeft).toBe(5)
    })

    it('asks the workspace to leave restoring to it, and only then', () => {
      const restoring = renderUnloaded({ initialScroll: LEFT_AT })
      expect(restoring.area).toHaveAttribute('data-workspace-scroll-surface', 'deferred')
      restoring.unmount()

      const plain = renderUnloaded()
      expect(plain.area).toHaveAttribute('data-workspace-scroll-surface', '')
    })
  })

  it('does not let the browser start a native image drag, which would fight panning', () => {
    const { image } = renderImage()

    expect(image).toHaveAttribute('draggable', 'false')
  })
})
