import { VoiceServiceError } from './errors.js'
import { VOICE_LIMITS, type VoiceLimits } from './types.js'

const HEADER_BYTES = 44
const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE

function invalid(message: string): never {
  throw new VoiceServiceError('voice/invalid-audio', message)
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

/**
 * Validates the canonical 44-byte-header WAV the desktop recorder produces:
 * PCM, mono, 16 kHz, 16-bit, with a `data` chunk that runs to end of file.
 * Returns the audio duration in seconds.
 */
export function validateVoiceWav(bytes: Uint8Array, limits: VoiceLimits = VOICE_LIMITS): { audioSeconds: number } {
  if (bytes.byteLength > limits.maxAudioBytes) {
    invalid(`Audio is too large (${bytes.byteLength} bytes, limit ${limits.maxAudioBytes})`)
  }
  if (bytes.byteLength < HEADER_BYTES) invalid('Audio is not a WAV file')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') invalid('Audio is not a WAV file')
  if (tag(bytes, 12) !== 'fmt ' || view.getUint32(16, true) !== 16 || tag(bytes, 36) !== 'data') {
    invalid('Unsupported WAV layout; expected a canonical 44-byte header')
  }
  if (view.getUint16(20, true) !== 1) invalid('Unsupported WAV encoding; expected PCM')
  if (view.getUint16(22, true) !== 1) invalid('Unsupported WAV channel count; expected mono')
  if (view.getUint32(24, true) !== SAMPLE_RATE) invalid(`Unsupported WAV sample rate; expected ${SAMPLE_RATE} Hz`)
  if (view.getUint16(34, true) !== 16) invalid('Unsupported WAV bit depth; expected 16-bit')

  const dataBytes = view.getUint32(40, true)
  if (dataBytes !== bytes.byteLength - HEADER_BYTES) invalid('WAV data length does not match file length')
  if (dataBytes === 0) invalid('Audio is empty')
  if (dataBytes % BYTES_PER_SAMPLE !== 0) invalid('WAV data is not a whole number of samples')

  const audioSeconds = dataBytes / BYTES_PER_SECOND
  if (audioSeconds > limits.maxAudioSeconds) {
    invalid(`Audio is too long (${audioSeconds.toFixed(1)} s, limit ${limits.maxAudioSeconds} s)`)
  }
  return { audioSeconds }
}
