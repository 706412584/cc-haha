import type { ThemeMode } from '../../types/settings'

export type OfficeThemePalette = {
  floor: number
  labelText: number
  taskText: number
  labelSurface: number
  bubbleSurface: number
  bubbleBorder: number
}

const LIGHT_PALETTE: OfficeThemePalette = {
  floor: 0xfaf9f5,
  labelText: 0x1b1c1a,
  taskText: 0x54433e,
  labelSurface: 0xffffff,
  bubbleSurface: 0xffffff,
  bubbleBorder: 0xdac1ba,
}

const PALETTES: Record<Exclude<ThemeMode, 'system'>, OfficeThemePalette> = {
  white: { ...LIGHT_PALETTE, floor: 0xffffff },
  light: LIGHT_PALETTE,
  eyeCare: {
    ...LIGHT_PALETTE,
    floor: 0xf3fbf6,
    labelSurface: 0xf9fefb,
    bubbleSurface: 0xf9fefb,
  },
  dark: {
    floor: 0x171917,
    labelText: 0xf2f1ed,
    taskText: 0xc8c7c2,
    labelSurface: 0x2f312e,
    bubbleSurface: 0x2f312e,
    bubbleBorder: 0x555751,
  },
}

export function resolveOfficeThemePalette(
  theme: Exclude<ThemeMode, 'system'>,
): OfficeThemePalette {
  return PALETTES[theme]
}
