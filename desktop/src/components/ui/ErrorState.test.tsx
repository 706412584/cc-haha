import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { ErrorState } from './ErrorState'

describe('ErrorState', () => {
  it('announces the failure through an alert', () => {
    // Most of the replaced markup was a plain <div>, which a screen reader user
    // only encounters by chance.
    render(<ErrorState title="Could not load plugins" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load plugins')
  })

  it('renders the detail alongside the title', () => {
    render(<ErrorState title="Request failed" detail="HTTP 502 from the gateway." />)
    expect(screen.getByText('HTTP 502 from the gateway.')).toBeInTheDocument()
  })

  it('offers a retry only when both handler and label are given', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<ErrorState title="Failed" onRetry={onRetry} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    rerender(<ErrorState title="Failed" onRetry={onRetry} retryLabel="Try again" />)
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('collapses 20 error backgrounds into two tones', () => {
    const { container: soft } = render(<ErrorState title="A" tone="soft" />)
    const { container: strong } = render(<ErrorState title="B" tone="strong" />)

    expect(soft.firstElementChild?.className).toContain('bg-[var(--color-error-soft)]')
    expect(strong.firstElementChild?.className).toContain('bg-[var(--color-error-container)]')
  })

  it('keeps the title on the error color in both tones', () => {
    for (const tone of ['soft', 'strong'] as const) {
      const { container } = render(<ErrorState title="Failed" tone={tone} />)
      expect(container.querySelector('span')?.className).toContain('text-[var(--color-error)]')
    }
  })
})
