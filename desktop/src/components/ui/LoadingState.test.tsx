import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { LoadingState } from './LoadingState'

describe('LoadingState', () => {
  it('announces itself politely, carrying the label as its content', () => {
    // A live region is announced by its content, not by an accessible name —
    // hence the text assertion rather than a name filter.
    render(<LoadingState label="Loading MCP servers" />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('Loading MCP servers')
  })

  it('keeps the label for screen readers when hidden visually', () => {
    render(<LoadingState label="Loading sessions" labelHidden />)
    expect(screen.getByText('Loading sessions')).toHaveClass('sr-only')
    expect(screen.getByRole('status')).toHaveTextContent('Loading sessions')
  })

  it('renders a spinner in every variant', () => {
    for (const variant of ['inline', 'block', 'dashed'] as const) {
      const { container } = render(<LoadingState label="Loading" variant={variant} />)
      expect(container.querySelector('svg.animate-spin')).toBeInTheDocument()
    }
  })

  it('scales the spinner with size', () => {
    const { container: small } = render(<LoadingState label="Loading" size="sm" />)
    const { container: large } = render(<LoadingState label="Loading" size="lg" />)

    const smallPx = Number(small.querySelector('svg')?.getAttribute('width'))
    const largePx = Number(large.querySelector('svg')?.getAttribute('width'))
    expect(largePx).toBeGreaterThan(smallPx)
  })

  it('only draws the placeholder box in the dashed variant', () => {
    const { container: block } = render(<LoadingState label="Loading" variant="block" />)
    expect(block.firstElementChild?.className).not.toContain('border-dashed')

    const { container: dashed } = render(<LoadingState label="Loading" variant="dashed" />)
    expect(dashed.firstElementChild?.className).toContain('border-dashed')
  })
})
