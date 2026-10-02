import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeWav, encodeWavBytes, floatToPcm16, toMono16k, VOICE_SAMPLE_RATE } from './wav'

function ascii(view: DataView, offset: number, length: number) {
  return String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)))
}

describe('encodeWavBytes', () => {
  it('writes a canonical 44-byte mono PCM16 header', () => {
    const bytes = encodeWavBytes(new Float32Array(160))
    const view = new DataView(bytes.buffer)

    expect(bytes.byteLength).toBe(44 + 160 * 2)
    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 160 * 2)
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(160 * 2)
  })

  it('stores samples little-endian and clamps out-of-range input', () => {
    const bytes = encodeWavBytes(new Float32Array([0, 1, -1, 0.5, 2, -2]))
    const view = new DataView(bytes.buffer)
    const read = (index: number) => view.getInt16(44 + index * 2, true)

    expect([0, 1, 2, 3, 4, 5].map(read)).toEqual([0, 32767, -32768, 16384, 32767, -32768])
  })

  it('records the requested sample rate in the header', () => {
    const view = new DataView(encodeWavBytes(new Float32Array(1), 8000).buffer)
    expect(view.getUint32(24, true)).toBe(8000)
    expect(view.getUint32(28, true)).toBe(16_000)
  })

  it('wraps the bytes in an audio/wav blob', () => {
    const blob = encodeWav(new Float32Array(10))
    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + 20)
  })
})

describe('floatToPcm16', () => {
  it('maps silence to zero', () => {
    expect(Array.from(floatToPcm16(new Float32Array(3)))).toEqual([0, 0, 0])
  })
})

describe('toMono16k', () => {
  const originalOffline = globalThis.OfflineAudioContext

  afterEach(() => {
    globalThis.OfflineAudioContext = originalOffline
  })

  function fakeBuffer(sampleRate: number, channels: number, seconds: number) {
    const length = Math.round(sampleRate * seconds)
    return {
      sampleRate,
      numberOfChannels: channels,
      duration: seconds,
      length,
      getChannelData: () => new Float32Array(length).fill(0.25),
    } as unknown as AudioBuffer
  }

  it('returns a buffer that already matches without rendering', async () => {
    const offline = vi.fn()
    globalThis.OfflineAudioContext = offline as unknown as typeof OfflineAudioContext

    const samples = await toMono16k(fakeBuffer(VOICE_SAMPLE_RATE, 1, 0.5))

    expect(samples).toHaveLength(8000)
    expect(offline).not.toHaveBeenCalled()
  })

  it('renders other rates and channel counts through a 16 kHz mono offline context', async () => {
    const constructed: Array<[number, number, number]> = []
    class FakeOffline {
      destination = {}
      constructor(channels: number, length: number, rate: number) {
        constructed.push([channels, length, rate])
      }
      createBufferSource() {
        return { buffer: null as AudioBuffer | null, connect: vi.fn(), start: vi.fn() }
      }
      async startRendering() {
        const length = constructed[0]![1]
        return { getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer
      }
    }
    globalThis.OfflineAudioContext = FakeOffline as unknown as typeof OfflineAudioContext

    // 1.5 s at 48 kHz stereo must come out as exactly 1.5 s at 16 kHz.
    const samples = await toMono16k(fakeBuffer(48_000, 2, 1.5))

    expect(constructed).toEqual([[1, 24_000, 16_000]])
    expect(samples).toHaveLength(24_000)
  })
})
