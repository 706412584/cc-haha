// @vitest-environment jsdom

import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageAnnotationModal } from './ImageAnnotationModal'
import { useOverlayStore } from '../../stores/overlayStore'

const image = { src: 'data:image/png;base64,AAAA', name: 'annotate.png' }
const fillTextCalls: Array<[string, number, number]> = []
const measureText = vi.fn((text: string) => ({ width: text.length * 12 }))

class TestImage {
  naturalWidth = 400
  naturalHeight = 300
  onload: (() => void) | null = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

function dispatchPointerEvent(element: Element, type: string, init: { clientX: number; clientY: number; pointerId: number }) {
  act(() => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, init)
    element.dispatchEvent(event)
  })
}

function installCanvasMocks() {
  fillTextCalls.length = 0
  measureText.mockClear()

  vi.stubGlobal('Image', TestImage)
  const context2d = {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    strokeText: vi.fn(),
    fillText: vi.fn((text: string, x: number, y: number) => {
      fillTextCalls.push([text, x, y])
    }),
    measureText,
    set strokeStyle(_value: string) {},
    set fillStyle(_value: string) {},
    set lineWidth(_value: number) {},
    set lineCap(_value: string) {},
    set lineJoin(_value: string) {},
    set font(_value: string) {},
    set textBaseline(_value: string) {},
  } as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((
    (contextId: string) => contextId === '2d' ? context2d : null
  ) as HTMLCanvasElement['getContext'])
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,SAVED')
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn()
  HTMLCanvasElement.prototype.hasPointerCapture = vi.fn(() => true)
  HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(() => ({
    left: 0,
    top: 0,
    width: 400,
    height: 300,
    right: 400,
    bottom: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }))
}

beforeEach(() => {
  useOverlayStore.setState(useOverlayStore.getInitialState(), true)
  installCanvasMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useOverlayStore.setState(useOverlayStore.getInitialState(), true)
})

describe('ImageAnnotationModal', () => {
  it('allows added text annotations to be dragged before saving', async () => {
    const onSave = vi.fn()
    render(<ImageAnnotationModal open image={image} onClose={() => {}} onSave={onSave} />)

    const canvas = document.querySelector('canvas')!
    await waitFor(() => expect(canvas.width).toBe(400))

    fireEvent.click(screen.getByRole('button', { name: /文字/ }))
    dispatchPointerEvent(canvas, 'pointerdown', { clientX: 80, clientY: 90, pointerId: 1 })
    fireEvent.change(await screen.findByPlaceholderText('输入标注文字'), { target: { value: '拖动我' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    dispatchPointerEvent(canvas, 'pointerdown', { clientX: 86, clientY: 88, pointerId: 2 })
    dispatchPointerEvent(canvas, 'pointermove', { clientX: 150, clientY: 140, pointerId: 2 })
    dispatchPointerEvent(canvas, 'pointerup', { clientX: 150, clientY: 140, pointerId: 2 })
    fireEvent.click(screen.getByRole('button', { name: '保存标注' }))

    expect(onSave).toHaveBeenCalledWith('data:image/png;base64,SAVED')
    expect(fillTextCalls.at(-1)).toEqual(['拖动我', 144, 142])
  })
})
