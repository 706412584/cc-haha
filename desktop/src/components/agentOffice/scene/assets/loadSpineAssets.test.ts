import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  load: vi.fn(),
}))

vi.mock('@esotericsoftware/spine-pixi-v8', () => ({}))
vi.mock('pixi.js', () => ({ Assets: mocks }))

async function loadModule() {
  return import('./loadSpineAssets')
}

describe('Spine asset loading', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('loads the first available pack and reuses the successful cache', async () => {
    mocks.load.mockResolvedValue([])
    const assets = await loadModule()

    await expect(assets.loadSpineAssets()).resolves.toBe(true)
    expect(assets.isSpineReady()).toBe(true)
    expect(assets.getSpineCharacterPack()).toBe('chibi-stickers')
    expect(assets.getSpineSkeletonAlias()).toBe('chibi-stickers-skeleton')
    expect(assets.getSpineAtlasAlias()).toBe('chibi-stickers-atlas')
    expect(mocks.add).toHaveBeenCalledTimes(2)
    expect(mocks.load).toHaveBeenCalledWith([
      'chibi-stickers-skeleton',
      'chibi-stickers-atlas',
    ])

    await assets.loadSpineAssets()
    expect(mocks.load).toHaveBeenCalledTimes(1)
  })

  it('reports failure without marking the pack ready', async () => {
    mocks.load.mockRejectedValue(new Error('atlas missing'))
    const assets = await loadModule()

    await expect(assets.loadSpineAssets()).resolves.toBe(false)
    expect(assets.isSpineReady()).toBe(false)
    expect(assets.getSpineCharacterPack()).toBeNull()
    expect(assets.getSpineSkeletonAlias()).toBe('')
    expect(assets.getSpineAtlasAlias()).toBe('')
  })
})
