import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { Progress } from './Progress'

describe('Progress', () => {
  it('exposes itself as a named progressbar with a value', () => {
    // Only one of the existing progress bars had role="progressbar" at all.
    render(<Progress label="Uploading" value={42} />)
    const bar = screen.getByRole('progressbar', { name: 'Uploading' })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })

  it('clamps out-of-range values', () => {
    const { rerender } = render(<Progress label="Uploading" value={-20} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')

    rerender(<Progress label="Uploading" value={180} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })

  it('drops the value attributes when indeterminate', () => {
    render(<Progress label="Working" indeterminate />)
    const bar = screen.getByRole('progressbar')
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar.className).toContain('progress-indeterminate-track')
  })

  it('uses the real indeterminate animation rather than a pulse', () => {
    // globals.css has had a proper sliding-segment implementation with a
    // reduced-motion fallback all along, and no callers.
    render(<Progress label="Working" indeterminate />)
    expect(screen.getByRole('progressbar').className).not.toContain('animate-pulse')
  })

  it('turns green at 100% with tone="auto"', () => {
    const { container: partial } = render(<Progress label="P" value={80} tone="auto" />)
    const { container: complete } = render(<Progress label="P" value={100} tone="auto" />)

    expect(partial.querySelector('[role="progressbar"] > div')?.className).toContain('--color-brand)')
    expect(complete.querySelector('[role="progressbar"] > div')?.className).toContain('--color-success)')
  })

  it('forwards arbitrary div attributes', () => {
    // Two loading bars stayed hand-rolled because their tests select by test
    // id and this component swallowed it.
    render(<Progress label="Loading" indeterminate data-testid="probe" id="load-bar" />)
    expect(screen.getByTestId('probe')).toHaveAttribute('id', 'load-bar')
  })

  it('sets the fill width from the value', () => {
    const { container } = render(<Progress label="Uploading" value={30} />)
    expect((container.querySelector('[role="progressbar"] > div') as HTMLElement).style.width).toBe('30%')
  })
})
