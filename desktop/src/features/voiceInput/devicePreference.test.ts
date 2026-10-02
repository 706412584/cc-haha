import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPreferredMicrophoneId, setPreferredMicrophoneId } from './devicePreference'

const KEY = 'cc-haha-voice-input-device'

describe('microphone preference', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips the chosen device id under the documented key', () => {
    setPreferredMicrophoneId('mic-2')
    expect(localStorage.getItem(KEY)).toBe('mic-2')
    expect(getPreferredMicrophoneId()).toBe('mic-2')
  })

  it('clears the preference when set to undefined', () => {
    setPreferredMicrophoneId('mic-2')
    setPreferredMicrophoneId(undefined)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(getPreferredMicrophoneId()).toBeUndefined()
  })

  it('treats an empty stored value as no preference', () => {
    localStorage.setItem(KEY, '')
    expect(getPreferredMicrophoneId()).toBeUndefined()
  })

  it('does not throw when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })

    expect(getPreferredMicrophoneId()).toBeUndefined()
    expect(() => setPreferredMicrophoneId('mic-2')).not.toThrow()
    expect(() => setPreferredMicrophoneId(undefined)).not.toThrow()
  })
})
