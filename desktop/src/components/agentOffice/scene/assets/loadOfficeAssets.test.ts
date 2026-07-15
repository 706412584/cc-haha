import type { Texture } from 'pixi.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  hasKey: vi.fn(),
  load: vi.fn(),
}))

vi.mock('pixi.js', () => ({
  Assets: {
    add: mocks.add,
    load: mocks.load,
    resolver: { hasKey: mocks.hasKey },
  },
}))

function texture(width: number, height: number) {
  return { width, height, source: { scaleMode: 'nearest' } } as unknown as Texture
}

async function loadModule() {
  return import('./loadOfficeAssets')
}

describe('office asset loading', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.hasKey.mockReturnValue(false)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('registers, loads, and caches all valid textures', async () => {
    const background = texture(960, 640)
    const desk = texture(152, 100)
    const chair = texture(104, 120)
    mocks.load.mockImplementation((alias: string) => {
      if (alias === 'office-background') return Promise.resolve(background)
      if (alias === 'office-desk') return Promise.resolve(desk)
      return Promise.resolve(chair)
    })
    const assets = await loadModule()

    await expect(assets.loadOfficeAssets()).resolves.toBe(true)

    expect(mocks.add).toHaveBeenCalledTimes(3)
    expect(assets.getOfficeBackgroundTexture()).toBe(background)
    expect(assets.getOfficeDeskTexture()).toBe(desk)
    expect(assets.getOfficeChairTexture()).toBe(chair)
    expect(assets.isOfficeAssetsReady()).toBe(true)
    expect(background.source.scaleMode).toBe('linear')
    expect(desk.source.scaleMode).toBe('linear')
  })

  it('does not re-register aliases already known to Pixi', async () => {
    mocks.hasKey.mockReturnValue(true)
    mocks.load.mockImplementation((alias: string) => Promise.resolve(
      alias === 'office-background' ? texture(10, 10) : texture(20, 20),
    ))
    const assets = await loadModule()

    await assets.loadOfficeAssets()

    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('keeps desks usable when only the optional background fails', async () => {
    mocks.load.mockImplementation((alias: string) => {
      if (alias === 'office-background') return Promise.reject(new Error('missing background'))
      return Promise.resolve(texture(20, 20))
    })
    const assets = await loadModule()

    await expect(assets.loadOfficeAssets()).resolves.toBe(true)
    expect(assets.getOfficeBackgroundTexture()).toBeNull()
    expect(assets.isOfficeAssetsReady()).toBe(true)
  })

  it('clears both desk textures when either required texture is invalid', async () => {
    mocks.load.mockImplementation((alias: string) => {
      if (alias === 'office-background') return Promise.resolve({})
      if (alias === 'office-desk') return Promise.resolve(texture(20, 20))
      return Promise.resolve({})
    })
    const assets = await loadModule()

    await expect(assets.loadOfficeAssets()).resolves.toBe(false)
    expect(assets.getOfficeBackgroundTexture()).toBeNull()
    expect(assets.getOfficeDeskTexture()).toBeNull()
    expect(assets.getOfficeChairTexture()).toBeNull()
    expect(assets.isOfficeAssetsReady()).toBe(false)
  })
})
