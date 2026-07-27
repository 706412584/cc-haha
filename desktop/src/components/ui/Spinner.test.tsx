import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { Spinner } from './Spinner'

describe('Spinner', () => {
  it('is hidden from assistive tech when it has no label', () => {
    // A spinner next to its own visible "Loading…" text would otherwise be
    // announced twice.
    const { container } = render(<Spinner />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('announces itself as a status when given a label', () => {
    render(<Spinner label="Loading sessions" />)
    const status = screen.getByRole('status', { name: 'Loading sessions' })
    expect(status).toBeInTheDocument()
    expect(status).not.toHaveAttribute('aria-hidden')
  })

  it('defaults to 16px', () => {
    const { container } = render(<Spinner />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '16')
    expect(svg).toHaveAttribute('height', '16')
  })

  it('honors an explicit size', () => {
    const { container } = render(<Spinner size={24} />)
    expect(container.querySelector('svg')).toHaveAttribute('width', '24')
  })

  it('inherits the text color by default and switches to brand on request', () => {
    const { container: currentTone } = render(<Spinner />)
    expect(currentTone.querySelector('svg')?.getAttribute('class')).not.toContain('--color-brand')

    const { container: brandTone } = render(<Spinner tone="brand" />)
    expect(brandTone.querySelector('svg')?.getAttribute('class')).toContain('text-[var(--color-brand)]')
  })

  it('always spins', () => {
    const { container } = render(<Spinner />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('animate-spin')
  })
})
