import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class Point {
    x = 0
    y = 0
    set = vi.fn((x: number, y = x) => { this.x = x; this.y = y })
  }
  class Container {
    children: unknown[] = []
    addChild = vi.fn((...children: unknown[]) => this.children.push(...children))
  }
  class Graphics extends Container {
    clear = vi.fn(() => this)
    ellipse = vi.fn(() => this)
    fill = vi.fn(() => this)
  }

  const findAnimation = vi.fn((name: string) => name === 'missing' ? null : { name })
  const findSkin = vi.fn((name: string) => name === 'missing-skin' ? null : { name })
  const findBone = vi.fn<() => { worldY: number } | null>(() => ({ worldY: -100 }))
  const setAnimation = vi.fn(() => ({ mixDuration: 0 }))
  const setSkinByName = vi.fn()
  const setSlotsToSetupPose = vi.fn()
  const colorSet = vi.fn()
  const spine = {
    skeleton: {
      data: { findAnimation, findSkin },
      color: { set: colorSet },
      setSkinByName,
      setSlotsToSetupPose,
      findBone,
    },
    state: {
      data: { defaultMix: 0 },
      timeScale: 1,
      setAnimation,
    },
    position: new Point(),
    scale: new Point(),
    y: 2,
  }
  const from = vi.fn(() => spine)
  const getPack = vi.fn((): 'chibi-stickers' | null => 'chibi-stickers')
  const getSkin = vi.fn(() => 'misaki')
  return {
    Container,
    Graphics,
    spine,
    from,
    findAnimation,
    findSkin,
    findBone,
    setAnimation,
    setSkinByName,
    setSlotsToSetupPose,
    colorSet,
    getPack,
    getSkin,
  }
})

vi.mock('pixi.js', () => ({ Container: mocks.Container, Graphics: mocks.Graphics }))
vi.mock('@esotericsoftware/spine-pixi-v8', () => ({ Spine: { from: mocks.from } }))
vi.mock('../assets/loadSpineAssets', () => ({
  getSpineCharacterPack: mocks.getPack,
  getSpineSkeletonAlias: () => 'skeleton',
  getSpineAtlasAlias: () => 'atlas',
}))
vi.mock('./chibiStickerSkins', () => ({ getChibiSkinName: mocks.getSkin }))

import { SpineCharacter } from './SpineCharacter'

describe('SpineCharacter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPack.mockReturnValue('chibi-stickers')
    mocks.getSkin.mockReturnValue('misaki')
    mocks.from.mockReturnValue(mocks.spine)
    mocks.findAnimation.mockImplementation((name: string) => name === 'missing' ? null : { name })
    mocks.findSkin.mockImplementation((name: string) => name === 'missing-skin' ? null : { name })
    mocks.findBone.mockReturnValue({ worldY: -100 })
    mocks.spine.scale.x = 0.3
    mocks.spine.scale.y = 0.3
    mocks.spine.y = 2
  })

  it('creates a ready skinned character and starts its preset animation', () => {
    const character = new SpineCharacter('main-agent', 0xff0000)

    expect(character.isReady).toBe(true)
    expect(mocks.from).toHaveBeenCalledWith({
      skeleton: 'skeleton',
      atlas: 'atlas',
      scale: 0.3,
      autoUpdate: true,
    })
    expect(mocks.setSkinByName).toHaveBeenCalledWith('misaki')
    expect(mocks.setSlotsToSetupPose).toHaveBeenCalled()
    expect(mocks.colorSet).toHaveBeenCalledWith(1, 1, 1, 1)
    expect(mocks.setAnimation).toHaveBeenCalledWith(0, 'movement/idle-front', true)
  })

  it('stays unready when no asset pack is active or construction throws', () => {
    mocks.getPack.mockReturnValueOnce(null)
    expect(new SpineCharacter('main-agent', 0).isReady).toBe(false)

    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.from.mockImplementationOnce(() => { throw new Error('invalid skeleton') })
    expect(new SpineCharacter('main-agent', 0).isReady).toBe(false)
  })

  it('switches walking animation for every view direction without mirroring', () => {
    const character = new SpineCharacter('office-agent-2', 0)
    mocks.setAnimation.mockClear()

    character.setViewFacing('left')
    character.playState('walking')
    expect(mocks.setAnimation).toHaveBeenLastCalledWith(0, 'movement/trot-right', true)

    character.setViewFacing('back')
    expect(mocks.setAnimation).toHaveBeenLastCalledWith(0, 'movement/trot-back', true)
    expect(mocks.spine.scale.x).toBe(0.3)
  })

  it('uses idle directional poses for work, thought, and side conversations', () => {
    const character = new SpineCharacter('office-agent-2', 0)

    character.setViewFacing('back')
    character.playState('working')
    expect(mocks.setAnimation).toHaveBeenLastCalledWith(0, 'movement/idle-back', true)

    character.setViewFacing('left')
    character.playState('thinking')
    expect(mocks.setAnimation).toHaveBeenLastCalledWith(0, 'movement/idle-right', true)

    character.playState('talking')
    expect(mocks.setAnimation).toHaveBeenLastCalledWith(0, 'movement/idle-right', true)
  })

  it('plays valid custom animations and rejects missing ones', () => {
    const character = new SpineCharacter('main-agent', 0)
    mocks.setAnimation.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    character.playAnimation('emotes/wave')
    expect(mocks.setAnimation).toHaveBeenCalledWith(0, 'emotes/wave', true)
    expect(mocks.spine.state.timeScale).toBe(1)

    character.playAnimation('missing')
    expect(mocks.setAnimation).toHaveBeenCalledTimes(1)
  })

  it('falls back to idle when a resolved animation is absent', () => {
    const character = new SpineCharacter('main-agent', 0)
    mocks.findAnimation.mockImplementation((name: string) =>
      name === 'emotes/thinking' ? null : { name },
    )

    character.playState('thinking')

    expect(mocks.setAnimation).toHaveBeenLastCalledWith(0, 'movement/idle-front', true)
  })

  it('reports head position from the skeleton and safe fallbacks', () => {
    const character = new SpineCharacter('main-agent', 0)
    expect(character.getHeadOffsetY()).toBeCloseTo(-48)

    mocks.findBone.mockReturnValueOnce(null)
    expect(character.getHeadOffsetY()).toBe(-82)

    mocks.findBone.mockReturnValueOnce({ worldY: 10 })
    expect(character.getHeadOffsetY()).toBe(-82)
  })

  it('ignores state and facing calls when assets are unavailable', () => {
    mocks.getPack.mockReturnValueOnce(null)
    const character = new SpineCharacter('main-agent', 0)

    character.setAgentColor(0xffffff)
    character.setFacing(-1)
    character.setViewFacing('left')
    character.playState('walking')
    character.playAnimation('emotes/wave')

    expect(character.getHeadOffsetY()).toBe(-52)
  })
})
