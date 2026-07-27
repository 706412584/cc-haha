import type { ThemeMode } from '../../types/settings'

export type OfficeThemePalette = {
  floor: number
  labelText: number
  taskText: number
  labelSurface: number
  bubbleSurface: number
  bubbleBorder: number
}

const WARM_CLASSIC_PALETTE: OfficeThemePalette = {
  floor: 0xfaf9f5,
  labelText: 0x1b1c1a,
  taskText: 0x54433e,
  labelSurface: 0xffffff,
  bubbleSurface: 0xffffff,
  bubbleBorder: 0xdac1ba,
}

const DARK_PALETTE: OfficeThemePalette = {
  floor: 0x171917,
  labelText: 0xf2f1ed,
  taskText: 0xc8c7c2,
  labelSurface: 0x2f312e,
  bubbleSurface: 0x2f312e,
  bubbleBorder: 0x555751,
}

const PALETTES: Record<ThemeMode, OfficeThemePalette> = {
  white: { ...WARM_CLASSIC_PALETTE, floor: 0xffffff },
  paper: {
    ...WARM_CLASSIC_PALETTE,
    floor: 0xf5f0e6,
    labelSurface: 0xfffcf5,
    bubbleSurface: 0xfffcf5,
  },
  'warm-classic': WARM_CLASSIC_PALETTE,
  celadon: {
    ...WARM_CLASSIC_PALETTE,
    floor: 0xf3fbf6,
    labelSurface: 0xf9fefb,
    bubbleSurface: 0xf9fefb,
    bubbleBorder: 0xbccfc4,
  },
  dark: DARK_PALETTE,
  'ink-blue': {
    ...DARK_PALETTE,
    floor: 0x111923,
    labelSurface: 0x243140,
    bubbleSurface: 0x243140,
    bubbleBorder: 0x4a6075,
  },
}

export function resolveOfficeThemePalette(theme: ThemeMode): OfficeThemePalette {
  return PALETTES[theme]
}
