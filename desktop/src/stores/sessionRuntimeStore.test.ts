import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionListItem } from '../types/session'
import {
  useSessionRuntimeStore,
  type SessionHandoffInfo,
} from './sessionRuntimeStore'

const STORAGE_KEY = 'cc-haha-session-handoff'

const sampleHandoff: SessionHandoffInfo = {
  previousSessionId: 'prev-id',
  previousSessionTitle: '上次会话标题',
  approxTokens: 1234,
  generatedAt: '2026-06-10T08:00:00.000Z',
}

describe('sessionRuntimeStore — handoffInfo', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset zustand store with empty maps in all three slots.
    useSessionRuntimeStore.setState({
      selections: {},
      coordinatorModes: {},
      handoffInfo: {},
    })
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('setHandoffInfo persists to store and to localStorage', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('session-a', sampleHandoff)

    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toEqual(sampleHandoff)
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(persisted['session-a']).toEqual(sampleHandoff)
  })

  it('clearHandoffInfo removes the entry from store and localStorage', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('session-a', sampleHandoff)
    useSessionRuntimeStore.getState().setHandoffInfo('session-b', { ...sampleHandoff, previousSessionId: 'other' })

    useSessionRuntimeStore.getState().clearHandoffInfo('session-a')

    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toBeUndefined()
    expect(useSessionRuntimeStore.getState().handoffInfo['session-b']).toBeDefined()
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(persisted['session-a']).toBeUndefined()
    expect(persisted['session-b']).toBeDefined()
  })

  it('clearHandoffInfo on a missing key is a no-op (does not touch state)', () => {
    const before = useSessionRuntimeStore.getState()
    useSessionRuntimeStore.getState().clearHandoffInfo('nonexistent')
    const after = useSessionRuntimeStore.getState()
    expect(after.handoffInfo).toBe(before.handoffInfo)
  })

  it('clearSelection also drops handoffInfo for the same key', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('session-a', sampleHandoff)
    useSessionRuntimeStore.getState().setSelection('session-a', {
      providerId: 'p',
      modelId: 'm',
    })

    useSessionRuntimeStore.getState().clearSelection('session-a')

    expect(useSessionRuntimeStore.getState().selections['session-a']).toBeUndefined()
    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toBeUndefined()
  })

  it('moveSelection migrates handoffInfo to the new key', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('draft-key', sampleHandoff)
    useSessionRuntimeStore.getState().setSelection('draft-key', {
      providerId: 'p',
      modelId: 'm',
    })

    useSessionRuntimeStore.getState().moveSelection('draft-key', 'real-session-id')

    expect(useSessionRuntimeStore.getState().handoffInfo['draft-key']).toBeUndefined()
    expect(useSessionRuntimeStore.getState().handoffInfo['real-session-id']).toEqual(sampleHandoff)
    expect(useSessionRuntimeStore.getState().selections['real-session-id']).toEqual({
      providerId: 'p',
      modelId: 'm',
    })
  })

  it('handoffInfo is independent of coordinatorModes (mutual non-interference)', () => {
    useSessionRuntimeStore.getState().setHandoffInfo('session-a', sampleHandoff)
    useSessionRuntimeStore.getState().setCoordinatorMode('session-a', true)

    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toEqual(sampleHandoff)
    expect(useSessionRuntimeStore.getState().coordinatorModes['session-a']).toBe(true)

    useSessionRuntimeStore.getState().clearHandoffInfo('session-a')

    expect(useSessionRuntimeStore.getState().handoffInfo['session-a']).toBeUndefined()
    expect(useSessionRuntimeStore.getState().coordinatorModes['session-a']).toBe(true)
  })
})

const EXPECTED_GROK_SELECTION = {
  providerId: 'grok-official',
  modelId: 'grok-4.5',
  effortLevel: 'high',
}

describe('sessionRuntimeStore runtime cleanup', () => {
  beforeEach(() => {
    localStorage.clear()
    useSessionRuntimeStore.setState({ selections: {} })
  })

  it('discards retired Grok selections before persisting them', () => {
    useSessionRuntimeStore.getState().setSelection('session-grok', {
      providerId: 'grok-official',
      modelId: 'grok-build',
      effortLevel: 'max',
    })

    expect(useSessionRuntimeStore.getState().selections['session-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-grok': EXPECTED_GROK_SELECTION,
    })
  })

  it('restores an explicit thinking override from session metadata', () => {
    useSessionRuntimeStore.getState().syncFromSessions([{
      id: 'session-thinking',
      runtimeProviderId: 'provider-a',
      runtimeModelId: 'model-a',
      effortLevel: 'high',
      thinkingEnabled: false,
    } as SessionListItem])

    expect(useSessionRuntimeStore.getState().selections['session-thinking']).toEqual({
      providerId: 'provider-a',
      modelId: 'model-a',
      effortLevel: 'high',
      thinkingEnabled: false,
    })
  })

  it('keeps an identical thinking selection stable and updates only changed overrides', () => {
    const session = {
      id: 'session-thinking-stable',
      runtimeProviderId: 'provider-a',
      runtimeModelId: 'model-a',
      effortLevel: 'high',
      thinkingEnabled: true,
    } as SessionListItem

    useSessionRuntimeStore.getState().syncFromSessions([session])
    const stableSelections = useSessionRuntimeStore.getState().selections
    useSessionRuntimeStore.getState().syncFromSessions([session])

    expect(useSessionRuntimeStore.getState().selections).toBe(stableSelections)

    useSessionRuntimeStore.getState().syncFromSessions([{
      ...session,
      thinkingEnabled: false,
    }])
    expect(useSessionRuntimeStore.getState().selections['session-thinking-stable']?.thinkingEnabled).toBe(false)
  })

  it('does not let retired Grok session metadata restore the removed model', () => {
    useSessionRuntimeStore.getState().syncFromSessions([{
      id: 'session-restored-grok',
      runtimeProviderId: 'grok-official',
      runtimeModelId: 'grok-build',
      effortLevel: 'max',
    } as SessionListItem])

    expect(useSessionRuntimeStore.getState().selections['session-restored-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
  })

  it('cleans a retired Grok selection loaded from localStorage', async () => {
    localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      'session-loaded-grok': {
        providerId: 'grok-official',
        modelId: 'grok-build',
        effortLevel: 'max',
      },
    }))
    vi.resetModules()

    const { useSessionRuntimeStore: loadedStore } = await import('./sessionRuntimeStore')

    expect(loadedStore.getState().selections['session-loaded-grok']).toEqual(
      EXPECTED_GROK_SELECTION,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-loaded-grok': EXPECTED_GROK_SELECTION,
    })
  })

  it('preserves a custom-provider xhigh selection loaded from localStorage', async () => {
    localStorage.setItem('cc-haha-session-runtime', JSON.stringify({
      'session-loaded-kimi': {
        providerId: 'kimi-provider',
        modelId: 'k3',
        effortLevel: 'xhigh',
      },
    }))
    vi.resetModules()

    const { useSessionRuntimeStore: loadedStore } = await import('./sessionRuntimeStore')

    const expectedSelection = {
      providerId: 'kimi-provider',
      modelId: 'k3',
      effortLevel: 'xhigh',
    }
    expect(loadedStore.getState().selections['session-loaded-kimi']).toEqual(
      expectedSelection,
    )
    expect(JSON.parse(localStorage.getItem('cc-haha-session-runtime')!)).toEqual({
      'session-loaded-kimi': expectedSelection,
    })
  })
})
