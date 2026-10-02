import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '@testing-library/jest-dom'
import { SessionAttentionMark } from './SessionAttentionMark'

afterEach(cleanup)

describe('SessionAttentionMark', () => {
  it('is one image with the given name', () => {
    render(<SessionAttentionMark label="Waiting for your approval" />)

    expect(screen.getByRole('img', { name: 'Waiting for your approval' })).toBeInTheDocument()
  })

  it('repeats the name as a native tooltip', () => {
    render(<SessionAttentionMark label="Waiting for your approval" />)

    expect(screen.getByRole('img')).toHaveAttribute('title', 'Waiting for your approval')
  })

  it('is not a live region, which would promise an announcement it cannot make', () => {
    render(<SessionAttentionMark label="Waiting for your approval" />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('hides the ligature text so a screen reader does not say "warning" beside the label', () => {
    const { container } = render(<SessionAttentionMark label="Waiting for your approval" />)

    const glyph = container.querySelector('.material-symbols-outlined')
    expect(glyph).toHaveTextContent('warning')
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws a filled glyph', () => {
    const { container } = render(<SessionAttentionMark label="Waiting" />)

    // Outlined at 14px the exclamation mark is a hairline; filled it is a shape.
    expect(container.querySelector('.material-symbols-outlined')).toHaveStyle({
      fontVariationSettings: "'FILL' 1",
    })
  })

  it('pulses three times and then holds still instead of blinking for hours', () => {
    const { container } = render(<SessionAttentionMark label="Waiting" />)

    const glyph = container.querySelector<HTMLElement>('.material-symbols-outlined')
    expect(glyph).toHaveClass('animate-pulse-dot')
    // Inline, so it overrides the `infinite` the class carries.
    expect(glyph?.style.animationIterationCount).toBe('3')
  })

  it('takes its colour from the darker warning token and hard-codes none', () => {
    const { container } = render(<SessionAttentionMark label="Waiting" />)

    // `--color-warning` is 2.92:1 on warm-classic's hovered sidebar row, and a
    // bare glyph has no text to fall back on; contrast.test.ts measures this token.
    expect(screen.getByRole('img').className).toContain('var(--color-on-warning-container)')
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})
