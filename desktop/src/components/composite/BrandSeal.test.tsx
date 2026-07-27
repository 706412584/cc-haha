import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { BrandSeal } from './BrandSeal'

const SIZES = ['sm', 'md', 'lg', 'xl'] as const

describe('BrandSeal', () => {
  it('is decorative and hidden from assistive tech', () => {
    // The product name always sits beside the mark (sidebar) or under it
    // (empty state); announcing the brand again reads it twice.
    const { container } = render(<BrandSeal />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws the two C strokes at every size', () => {
    // Whatever else is shed, the double C is the mark. If this count drops the
    // remaining shape is no longer recognizable as the logo.
    for (const size of SIZES) {
      const { container, unmount } = render(<BrandSeal size={size} />)
      const strokes = container.querySelectorAll('g[stroke="var(--color-text-primary)"] path')
      expect(strokes).toHaveLength(3) // big C + the second C's two arcs
      unmount()
    }
  })

  it('paints from tokens so all six palettes recolor it', () => {
    // This is why the vector replaced the raster app icon: a bitmap kept its
    // own blue and orange under every theme while the chrome around it moved.
    const { container } = render(<BrandSeal size="xl" />)
    const svg = container.firstElementChild!
    expect(svg.querySelector('[stroke="var(--color-text-primary)"]')).not.toBeNull()
    expect(svg.querySelector('[stroke="var(--color-brand)"]')).not.toBeNull()
    expect(svg.querySelector('[fill="var(--color-brand)"]')).not.toBeNull()
    // No literal hex anywhere — that would survive a theme switch unchanged.
    expect(svg.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('sheds parts as it shrinks instead of turning to mush', () => {
    // At 38px a sparkle is under 2px across and reads as dirt; at 24px the
    // cursor merges into the second C.
    const count = (size: (typeof SIZES)[number]) => {
      const { container, unmount } = render(<BrandSeal size={size} />)
      const filled = container.querySelectorAll('path[fill="var(--color-brand)"]').length
      unmount()
      return filled
    }
    expect(count('xl')).toBe(3) // cursor + two sparkles
    expect(count('lg')).toBe(1) // cursor only
    expect(count('md')).toBe(1)
    expect(count('sm')).toBe(0) // the C's and the bar
  })

  it('crops the viewBox to the ink so the mark fills its box', () => {
    // A full 0 0 1024 1024 viewBox would letterbox the mark to roughly half
    // the height of its container at every size.
    for (const size of SIZES) {
      const { container, unmount } = render(<BrandSeal size={size} />)
      const viewBox = container.firstElementChild!.getAttribute('viewBox')!
      const [x, y, w, h] = viewBox.split(' ').map(Number)
      expect(x).toBeGreaterThan(200)
      expect(y).toBeGreaterThan(200)
      expect(w).toBeLessThan(1024)
      expect(h).toBeLessThan(1024)
      unmount()
    }
  })
})
