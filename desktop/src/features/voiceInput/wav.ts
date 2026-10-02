/** The only format the voice service accepts: 16 kHz, mono, 16-bit PCM. */
export const VOICE_SAMPLE_RATE = 16_000

const WAV_HEADER_BYTES = 44

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
}

/** Float samples in [-1, 1] to little-endian PCM16, clamping anything outside. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    // Asymmetric scale keeps +1.0 at 32767 and -1.0 at -32768.
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
  }
  return out
}

/** A canonical 44-byte-header RIFF/WAVE file holding mono PCM16. */
export function encodeWavBytes(samples: Float32Array, sampleRate: number = VOICE_SAMPLE_RATE): Uint8Array {
  const pcm = floatToPcm16(samples)
  const dataBytes = pcm.length * 2
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  // Explicit little-endian writes: an Int16Array view would follow the host's
  // byte order.
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i]!, true)
  return new Uint8Array(buffer)
}

export function encodeWav(samples: Float32Array, sampleRate: number = VOICE_SAMPLE_RATE): Blob {
  return new Blob([encodeWavBytes(samples, sampleRate) as BlobPart], { type: 'audio/wav' })
}

/**
 * Mixes a decoded buffer down to mono and resamples it to 16 kHz.
 *
 * The offline context does both: a one-channel destination downmixes on connect
 * and the destination rate drives the resample, so no hand-written filter is
 * needed. Buffers that already match skip the render.
 */
export async function toMono16k(buffer: AudioBuffer): Promise<Float32Array> {
  if (buffer.sampleRate === VOICE_SAMPLE_RATE && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice()
  }
  const length = Math.max(1, Math.ceil(buffer.duration * VOICE_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, length, VOICE_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = buffer
  source.connect(offline.destination)
  source.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}
