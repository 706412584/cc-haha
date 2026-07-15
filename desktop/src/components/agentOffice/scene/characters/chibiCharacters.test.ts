import { describe, expect, it } from 'vitest'
import { AGENT_ROSTER } from '../layout/officeLayout'
import {
  CHIBI_AGENT_PRESETS,
  getChibiAgentPreset,
  resolveChibiPresetAnim,
} from './chibiAgentPresets'
import {
  CHIBI_CHARACTER_SKINS,
  getChibiSkinName,
} from './chibiStickerSkins'

describe('chibi character mappings', () => {
  it('provides deterministic presets for the six office agents', () => {
    expect(Object.keys(CHIBI_AGENT_PRESETS)).toHaveLength(6)
    expect(getChibiAgentPreset('main-agent')).toMatchObject({ facing: 'front' })
    expect(resolveChibiPresetAnim('main-agent', 'thinking')).toBe('emotes/thinking')
    expect(resolveChibiPresetAnim('office-agent-3', 'working')).toBe('movement/idle-back')
  })

  it('lets directional walking override static presets', () => {
    expect(resolveChibiPresetAnim('main-agent', 'walking')).toBeNull()
    expect(resolveChibiPresetAnim('missing-agent', 'idle')).toBeNull()
    expect(resolveChibiPresetAnim('office-agent-2', 'talking')).toBe('emotes/excited')
  })

  it('assigns roster skins in order and uses spineboy for unknown agents', () => {
    expect(CHIBI_CHARACTER_SKINS).toHaveLength(9)
    expect(AGENT_ROSTER.map((agent) => getChibiSkinName(agent.id))).toEqual(
      CHIBI_CHARACTER_SKINS.slice(0, AGENT_ROSTER.length),
    )
    expect(getChibiSkinName('unknown-agent')).toBe('spineboy')
  })
})
