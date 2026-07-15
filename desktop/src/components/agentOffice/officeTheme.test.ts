import { describe, expect, it } from 'vitest'
import { resolveOfficeThemePalette } from './officeTheme'

describe('resolveOfficeThemePalette', () => {
  it('provides contrasting Pixi palettes for dark and light themes', () => {
    const light = resolveOfficeThemePalette('light')
    const dark = resolveOfficeThemePalette('dark')

    expect(light.floor).not.toBe(dark.floor)
    expect(light.labelText).not.toBe(dark.labelText)
    expect(dark.bubbleSurface).not.toBe(0xffffff)
  })

  it('uses a distinct eye-care palette', () => {
    expect(resolveOfficeThemePalette('eyeCare').floor).not.toBe(
      resolveOfficeThemePalette('light').floor,
    )
  })
})
