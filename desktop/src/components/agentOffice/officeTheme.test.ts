import { describe, expect, it } from 'vitest'
import { resolveOfficeThemePalette } from './officeTheme'
import { THEME_MODES } from '../../types/settings'

describe('resolveOfficeThemePalette', () => {
  it('provides contrasting Pixi palettes for ink and paper themes', () => {
    const paper = resolveOfficeThemePalette('warm-classic')
    const ink = resolveOfficeThemePalette('dark')

    expect(paper.floor).not.toBe(ink.floor)
    expect(paper.labelText).not.toBe(ink.labelText)
    expect(ink.bubbleSurface).not.toBe(0xffffff)
  })

  it('defines a usable palette for every selectable theme including neutral dark', () => {
    for (const theme of THEME_MODES) {
      const palette = resolveOfficeThemePalette(theme)
      expect(palette).toBeDefined()
      expect(palette.floor).not.toBe(palette.labelText)
    }
    expect(resolveOfficeThemePalette('neutral-dark')).toMatchObject({ floor: 0x202020, labelText: 0xf2f2f2 })
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
