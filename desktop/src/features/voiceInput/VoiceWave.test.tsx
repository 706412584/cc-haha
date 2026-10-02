import { act, cleanup, render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceWave } from './VoiceWave'

const HEIGHT = 44
const MIDDLE = HEIGHT / 2

type FakeContext = {
  setTransform: ReturnType<typeof vi.fn>
  clearRect: ReturnType<typeof vi.fn>
  beginPath: ReturnType<typeof vi.fn>
  moveTo: ReturnType<typeof vi.fn>
  lineTo: ReturnType<typeof vi.fn>
  stroke: ReturnType<typeof vi.fn>
  globalAlpha: number
  lineWidth: number
  strokeStyle: string
  lineCap: string
  lineJoin: string
}

let context: FakeContext
let frames: Map<number, FrameRequestCallback>
let nextFrameId: number
let cancelFrame: ReturnType<typeof vi.fn>
let disconnect: ReturnType<typeof vi.fn>
let resize: (width: number) => void
let reducedMotion: boolean
let hidden: boolean

function makeContext(): FakeContext {
  return {
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', lineCap: '', lineJoin: '',
  }
}

/** Runs the queued frames once, `now` milliseconds on the animation clock. */
function runFrames(now: number) {
  const batch = [...frames.values()]
  frames.clear()
  act(() => { for (const callback of batch) callback(now) })
}

/** Largest distance any drawn point of the last stroked layer reached from the centre line. */
function peakOffset(): number {
  return Math.max(...context.lineTo.mock.calls.map(([, y]) => Math.abs((y as number) - MIDDLE)))
}

/** Runs one frame and returns the y values the first (top) layer drew in it. */
function topLayerAt(now: number): number[] {
  context.moveTo.mockClear()
  context.lineTo.mockClear()
  runFrames(now)
  const points = context.lineTo.mock.calls
  return points.slice(0, points.length / 3).map(([, y]) => y as number)
}

function expectClose(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((y, index) => expect(y).toBeCloseTo(expected[index]!, 6))
}

beforeEach(() => {
  context = makeContext()
  frames = new Map()
  nextFrameId = 1
  cancelFrame = vi.fn((id: number) => { frames.delete(id) })
  disconnect = vi.fn()
  reducedMotion = false
  hidden = false

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as never)
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, get: () => 300 })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resize = (width) => callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
    }
    observe() {}
    unobserve() {}
    disconnect = disconnect
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('prefers-reduced-motion') && reducedMotion },
  }))
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  vi.stubGlobal('devicePixelRatio', 2)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'clientWidth')
  Reflect.deleteProperty(document, 'hidden')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VoiceWave', () => {
  it('reads the level and draws three layers on every frame while active', () => {
    const getLevel = vi.fn(() => 0.5)
    const layers: Array<{ alpha: number; width: number }> = []
    context.stroke.mockImplementation(() => { layers.push({ alpha: context.globalAlpha, width: context.lineWidth }) })
    render(<VoiceWave getLevel={getLevel} active />)
    layers.length = 0

    expect(frames.size).toBe(1)
    runFrames(1_000)
    expect(getLevel).toHaveBeenCalledTimes(1)
    // The top layer is opaque and full width; the lower two are fainter and thinner.
    expect(layers).toEqual([
      { alpha: 1, width: 2 },
      { alpha: 0.42, width: 1.25 },
      { alpha: 0.26, width: 1 },
    ])
    expect(context.lineCap).toBe('round')
    runFrames(1_016)
    expect(getLevel).toHaveBeenCalledTimes(2)
    expect(layers).toHaveLength(6)
  })

  it('marks the canvas decorative and sizes it to the container at the device pixel ratio', () => {
    const { container } = render(<VoiceWave getLevel={() => 0} active />)
    const canvas = container.querySelector('canvas')!

    expect(canvas).toHaveAttribute('aria-hidden', 'true')
    expect(canvas.style.height).toBe('44px')
    // 300 css px wide, 44 tall, at 2x.
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(88)
    expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0)

    act(() => resize(420))
    expect(canvas.width).toBe(840)
    expect(canvas.height).toBe(88)
  })

  it('pins both ends to the centre line so the wave floats in the middle', () => {
    render(<VoiceWave getLevel={() => 1} active />)
    runFrames(1_000)
    runFrames(1_500)

    const first = context.moveTo.mock.calls[0]!
    expect(first[0]).toBe(0)
    expect(first[1]).toBeCloseTo(MIDDLE, 5)
    const last = context.lineTo.mock.calls.filter(([x]) => x === 300)[0]!
    expect(last[1]).toBeCloseTo(MIDDLE, 5)
    // ... while the middle of the wave does swing.
    expect(peakOffset()).toBeGreaterThan(8)
  })

  it('rises quickly on loud input and falls back slowly', () => {
    let level = 0
    render(<VoiceWave getLevel={() => level} active />)
    runFrames(1_000)
    context.lineTo.mockClear()
    runFrames(1_016)
    const idle = peakOffset()

    level = 1
    context.lineTo.mockClear()
    runFrames(1_032)
    const attacked = peakOffset()
    // One 16 ms frame already covers a good part of the way up.
    expect(attacked).toBeGreaterThan(idle + 3)

    for (let time = 1_048; time < 1_300; time += 16) runFrames(time)
    context.lineTo.mockClear()
    runFrames(1_316)
    const loud = peakOffset()

    level = 0
    context.lineTo.mockClear()
    runFrames(1_332)
    const released = peakOffset()
    // Still most of the way up one frame after the input went quiet ...
    expect(released).toBeGreaterThan(loud * 0.8)
    // ... and settled back down a couple of seconds later.
    for (let time = 1_348; time < 3_400; time += 16) runFrames(time)
    context.lineTo.mockClear()
    runFrames(3_416)
    expect(peakOffset()).toBeLessThan(idle + 1)
  })

  it('keeps a near-flat line when there is no sound', () => {
    render(<VoiceWave getLevel={() => 0} active />)
    runFrames(1_000)
    runFrames(1_016)

    expect(peakOffset()).toBeGreaterThan(0.5)
    expect(peakOffset()).toBeLessThan(3)
  })

  it('draws one calm frame and schedules nothing while inactive', () => {
    const getLevel = vi.fn(() => 1)
    render(<VoiceWave getLevel={getLevel} active={false} />)

    expect(frames.size).toBe(0)
    expect(getLevel).not.toHaveBeenCalled()
    // A single static paint at mount: three layers, nothing more.
    expect(context.stroke).toHaveBeenCalledTimes(3)
    expect(peakOffset()).toBeLessThan(3)
  })

  it('stops reading the level and cancels the frame when it goes inactive', () => {
    const getLevel = vi.fn(() => 0.5)
    const { rerender } = render(<VoiceWave getLevel={getLevel} active />)
    runFrames(1_000)
    const readsWhileActive = getLevel.mock.calls.length

    rerender(<VoiceWave getLevel={getLevel} active={false} />)

    expect(cancelFrame).toHaveBeenCalled()
    expect(frames.size).toBe(0)
    runFrames(1_016)
    expect(getLevel).toHaveBeenCalledTimes(readsWhileActive)
  })

  it('cancels the frame, disconnects the observer and stops reading on unmount', () => {
    const getLevel = vi.fn(() => 0.5)
    const { unmount } = render(<VoiceWave getLevel={getLevel} active />)
    runFrames(1_000)
    const reads = getLevel.mock.calls.length

    unmount()

    expect(cancelFrame).toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
    expect(frames.size).toBe(0)
    expect(getLevel).toHaveBeenCalledTimes(reads)
  })

  it('does not restart the loop when the parent passes a new getLevel function', () => {
    const first = vi.fn(() => 0.2)
    const second = vi.fn(() => 0.8)
    const { rerender } = render(<VoiceWave getLevel={first} active />)
    runFrames(1_000)

    rerender(<VoiceWave getLevel={second} active />)

    expect(cancelFrame).not.toHaveBeenCalled()
    runFrames(1_016)
    expect(second).toHaveBeenCalled()
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('does not throw or animate when the canvas has no 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)

    expect(() => render(<VoiceWave getLevel={() => 1} active />)).not.toThrow()
    expect(frames.size).toBe(0)
  })

  it('does not spin while the window is hidden, and resumes when it returns', () => {
    hidden = true
    const getLevel = vi.fn(() => 0.5)
    render(<VoiceWave getLevel={getLevel} active />)
    expect(frames.size).toBe(0)

    hidden = false
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(frames.size).toBe(1)
    runFrames(1_000)
    expect(getLevel).toHaveBeenCalledTimes(1)

    hidden = true
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(frames.size).toBe(0)
    expect(cancelFrame).toHaveBeenCalled()
  })

  it('flows forward over time normally', () => {
    render(<VoiceWave getLevel={() => 0.6} active />)
    runFrames(1_000)
    const before = topLayerAt(1_100)
    const after = topLayerAt(1_200)

    expect(after).not.toEqual(before)
  })

  it('holds the phase under prefers-reduced-motion and only lets the level change the height', () => {
    reducedMotion = true
    let level = 0.6
    render(<VoiceWave getLevel={() => level} active />)
    // Let the smoothed level settle so only the phase could differ between frames.
    for (let time = 1_000; time < 3_000; time += 16) runFrames(time)
    const before = topLayerAt(3_016)
    const after = topLayerAt(3_500)
    expectClose(after, before)

    level = 1
    for (let time = 3_516; time < 5_000; time += 16) runFrames(time)
    const louder = topLayerAt(5_016)
    expect(Math.max(...louder.map(y => Math.abs(y - MIDDLE)))).toBeGreaterThan(Math.max(...after.map(y => Math.abs(y - MIDDLE))))
  })
})
