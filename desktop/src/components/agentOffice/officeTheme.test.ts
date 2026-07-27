import { describe, expect, it } from 'vitest'
import { resolveOfficeThemePalette } from './officeTheme'

describe('resolveOfficeThemePalette', () => {
  it('provides contrasting Pixi palettes for ink and paper themes', () => {
    const paper = resolveOfficeThemePalette('warm-classic')
    const ink = resolveOfficeThemePalette('dark')

    expect(paper.floor).not.toBe(ink.floor)
    expect(paper.labelText).not.toBe(ink.labelText)
    expect(ink.bubbleSurface).not.toBe(0xffffff)
  })

  it('maps celadon and ink blue to distinct office palettes', () => {
    expect(resolveOfficeThemePalette('celadon').floor).not.toBe(
      resolveOfficeThemePalette('warm-classic').floor,
    )
    expect(resolveOfficeThemePalette('ink-blue').floor).not.toBe(
      resolveOfficeThemePalette('dark').floor,
    )
  })
})
