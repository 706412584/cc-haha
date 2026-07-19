import { describe, expect, it, vi } from 'vitest'
import { loadAndRevealMainWindow } from './windowStartup'

describe('Electron main window startup', () => {
  it('reveals the main window after the renderer loads', async () => {
    const order: string[] = []
    const onLoadFailure = vi.fn()

    const result = await loadAndRevealMainWindow({
      load: async () => { order.push('load') },
      beforeReveal: () => { order.push('before-reveal') },
      reveal: () => { order.push('reveal') },
      onLoadFailure,
    })

    expect(result).toEqual({ loaded: true })
    expect(order).toEqual(['load', 'before-reveal', 'reveal'])
    expect(onLoadFailure).not.toHaveBeenCalled()
  })

  it('still reveals the main window and reports the error when renderer loading fails', async () => {
    const order: string[] = []
    const failure = new Error('renderer entry unavailable')

    const result = await loadAndRevealMainWindow({
      load: async () => {
        order.push('load')
        throw failure
      },
      beforeReveal: () => { order.push('before-reveal') },
      reveal: () => { order.push('reveal') },
      onLoadFailure: (error) => {
        expect(error).toBe(failure)
        order.push('failure')
      },
    })

    expect(result).toEqual({ loaded: false, error: failure })
    expect(order).toEqual(['load', 'before-reveal', 'reveal', 'failure'])
  })

  it('treats an undefined rejection as a load failure', async () => {
    const reveal = vi.fn()
    const onLoadFailure = vi.fn()

    const result = await loadAndRevealMainWindow({
      load: () => Promise.reject(undefined),
      beforeReveal: vi.fn(),
      reveal,
      onLoadFailure,
    })

    expect(result).toEqual({ loaded: false, error: undefined })
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(onLoadFailure).toHaveBeenCalledWith(undefined)
  })
})
