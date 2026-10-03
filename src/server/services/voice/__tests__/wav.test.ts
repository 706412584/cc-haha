import { describe, expect, test } from 'bun:test'
import { VoiceServiceError } from '../errors.js'
import { VOICE_LIMITS } from '../types.js'
import { validateVoiceWav } from '../wav.js'
import { makeWav } from './fakeProvider.js'

function expectInvalid(bytes: Uint8Array, pattern: RegExp) {
  try {
    validateVoiceWav(bytes)
  } catch (error) {
    expect(error).toBeInstanceOf(VoiceServiceError)
    expect((error as VoiceServiceError).code).toBe('voice/invalid-audio')
    expect((error as VoiceServiceError).status).toBe(400)
    expect((error as Error).message).toMatch(pattern)
    return
  }
  throw new Error('expected validateVoiceWav to throw')
}

describe('validateVoiceWav', () => {
  test('accepts a canonical 16 kHz mono PCM16 file and reports its duration', () => {
    expect(validateVoiceWav(makeWav(1.5))).toEqual({ audioSeconds: 1.5 })
  })

  test('accepts audio exactly at the duration limit', () => {
    expect(validateVoiceWav(makeWav(VOICE_LIMITS.maxAudioSeconds)).audioSeconds).toBe(VOICE_LIMITS.maxAudioSeconds)
  })

  test('accepts a view into a larger buffer (byteOffset is honoured)', () => {
    const wav = makeWav(0.5)
    const padded = new Uint8Array(wav.byteLength + 7)
    padded.set(wav, 7)

    expect(validateVoiceWav(padded.subarray(7)).audioSeconds).toBe(0.5)
  })

  test('rejects audio longer than the duration limit', () => {
    expectInvalid(makeWav(VOICE_LIMITS.maxAudioSeconds + 1), /too long/)
  })

  test('rejects bodies larger than the byte limit before parsing them', () => {
    expectInvalid(new Uint8Array(VOICE_LIMITS.maxAudioBytes + 1), /too large/)
  })

  test('rejects files shorter than a header and non-WAV data', () => {
    expectInvalid(new Uint8Array(10), /not a WAV/)
    expectInvalid(makeWav(0.1, { riff: 'RIFX' }), /not a WAV/)
    expectInvalid(makeWav(0.1, { wave: 'AVI ' }), /not a WAV/)
  })

  test('rejects a header-only file as empty', () => {
    expectInvalid(makeWav(0), /empty/)
  })

  test.each([
    ['stereo', { channels: 2 }, /mono/],
    ['44.1 kHz', { sampleRate: 44_100 }, /sample rate/],
    ['8-bit', { bits: 8 }, /bit depth/],
    ['float encoding', { format: 3 }, /PCM/],
  ] as const)('rejects %s audio', (_label, overrides, pattern) => {
    expectInvalid(makeWav(0.1, overrides), pattern)
  })

  test('rejects a data length that disagrees with the file length', () => {
    expectInvalid(makeWav(0.1, { dataLength: 100 }), /does not match/)
    expectInvalid(makeWav(0.1, { dataLength: 0xffffffff }), /does not match/)
  })

  test('rejects a data chunk that is not a whole number of samples', () => {
    const wav = makeWav(0.1)
    const odd = wav.subarray(0, wav.byteLength - 1)
    new DataView(odd.buffer, odd.byteOffset, odd.byteLength).setUint32(40, odd.byteLength - 44, true)

    expectInvalid(odd, /whole number of samples/)
  })

  test('rejects an extended fmt chunk (non-canonical header)', () => {
    const wav = makeWav(0.1)
    new DataView(wav.buffer).setUint32(16, 18, true)

    expectInvalid(wav, /canonical/)
  })
})
