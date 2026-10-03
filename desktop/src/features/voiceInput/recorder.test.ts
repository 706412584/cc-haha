import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isVoiceCaptureSupported, startRecording, VoiceRecorderError } from './recorder'

class FakeTrack extends EventTarget {
  stopped = false
  stop() {
    this.stopped = true
  }
  end() {
    this.dispatchEvent(new Event('ended'))
  }
}

class FakeStream {
  tracks = [new FakeTrack()]
  getTracks() {
    return this.tracks
  }
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = vi.fn((type: string) => type === 'audio/webm;codecs=opus')
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  stopCalls = 0
  constructor(public stream: FakeStream, options?: { mimeType?: string }) {
    super()
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.stopCalls += 1
    if (this.state === 'inactive') return
    this.state = 'inactive'
    this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob(['audio-bytes']) }))
    this.dispatchEvent(new Event('stop'))
  }
}

let decodedSeconds = 2
let decodeShouldFail = false
const offlineConstructions: Array<[number, number, number]> = []

class FakeOfflineAudioContext {
  destination = {}
  constructor(public channels: number, public length: number, public rate: number) {
    offlineConstructions.push([channels, length, rate])
  }
  async decodeAudioData() {
    if (decodeShouldFail) throw new DOMException('bad data', 'EncodingError')
    return {
      sampleRate: 48_000,
      numberOfChannels: 2,
      duration: decodedSeconds,
      getChannelData: () => new Float32Array(48_000 * decodedSeconds),
    } as unknown as AudioBuffer
  }
  createBufferSource() {
    return { buffer: null, connect: vi.fn(), start: vi.fn() }
  }
  async startRendering() {
    return { getChannelData: () => new Float32Array(this.length).fill(0.1) } as unknown as AudioBuffer
  }
}

const audioContexts: FakeAudioContext[] = []

class FakeAudioContext {
  state = 'running'
  closed = false
  constructor() {
    audioContexts.push(this)
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() }
  }
  createAnalyser() {
    return {
      fftSize: 0,
      getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(0.05),
    }
  }
  async resume() {}
  async close() {
    this.closed = true
    this.state = 'closed'
  }
}

const originals = {
  mediaDevices: Object.getOwnPropertyDescriptor(navigator, 'mediaDevices'),
  secure: Object.getOwnPropertyDescriptor(window, 'isSecureContext'),
  mediaRecorder: globalThis.MediaRecorder,
  audioContext: globalThis.AudioContext,
  offline: globalThis.OfflineAudioContext,
}

let getUserMedia: ReturnType<typeof vi.fn>
let streams: FakeStream[]

function domError(name: string) {
  return new DOMException(name, name)
}

function grantMicrophone() {
  getUserMedia.mockImplementation(async () => {
    const stream = new FakeStream()
    streams.push(stream)
    return stream
  })
}

function allTracksStopped() {
  return streams.length > 0 && streams.every(stream => stream.tracks.every(track => track.stopped))
}

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true })
}

describe('recorder', () => {
  beforeEach(() => {
    streams = []
    audioContexts.length = 0
    offlineConstructions.length = 0
    FakeMediaRecorder.instances = []
    decodedSeconds = 2
    decodeShouldFail = false
    getUserMedia = vi.fn()
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
    setSecureContext(true)
    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
    globalThis.OfflineAudioContext = FakeOfflineAudioContext as unknown as typeof OfflineAudioContext
    grantMicrophone()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originals.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', originals.mediaDevices)
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices
    if (originals.secure) Object.defineProperty(window, 'isSecureContext', originals.secure)
    else delete (window as { isSecureContext?: unknown }).isSecureContext
    globalThis.MediaRecorder = originals.mediaRecorder
    globalThis.AudioContext = originals.audioContext
    globalThis.OfflineAudioContext = originals.offline
  })

  describe('isVoiceCaptureSupported', () => {
    it('is true with a secure context, getUserMedia and MediaRecorder', () => {
      expect(isVoiceCaptureSupported()).toBe(true)
    })

    it('is false outside a secure context (plain-http LAN pages)', () => {
      setSecureContext(false)
      expect(isVoiceCaptureSupported()).toBe(false)
    })

    it('is false without getUserMedia', () => {
      Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
      expect(isVoiceCaptureSupported()).toBe(false)
    })

    it('is false without MediaRecorder', () => {
      globalThis.MediaRecorder = undefined as unknown as typeof MediaRecorder
      expect(isVoiceCaptureSupported()).toBe(false)
    })
  })

  describe('a successful recording', () => {
    it('returns a 16 kHz mono WAV and releases every track', async () => {
      decodedSeconds = 1.5
      const recording = await startRecording({ maxSeconds: 60 })
      const result = await recording.stop()

      expect(result.seconds).toBeCloseTo(1.5, 5)
      expect(result.wav.type).toBe('audio/wav')
      // 44-byte header plus 24000 16-bit samples.
      expect(result.wav.size).toBe(44 + 24_000 * 2)
      // decodeAudioData context first, then the 48 kHz stereo -> 16 kHz mono render.
      expect(offlineConstructions).toEqual([[1, 1, 16_000], [1, 24_000, 16_000]])
      expect(allTracksStopped()).toBe(true)
      expect(audioContexts.every(context => context.closed)).toBe(true)
    })

    it('asks for echo cancellation and noise suppression on the default device', async () => {
      const recording = await startRecording({ maxSeconds: 60 })
      expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true } })
      recording.cancel()
    })

    it('pins the preferred device with an exact constraint', async () => {
      const recording = await startRecording({ maxSeconds: 60, deviceId: 'usb-1' })
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: { echoCancellation: true, noiseSuppression: true, deviceId: { exact: 'usb-1' } },
      })
      recording.cancel()
    })

    it('prefers an opus container when the browser supports one', async () => {
      const recording = await startRecording({ maxSeconds: 60 })
      expect(FakeMediaRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus')
      recording.cancel()
    })

    it('shares one result between repeated stop calls', async () => {
      const recording = await startRecording({ maxSeconds: 60 })
      const [first, second] = await Promise.all([recording.stop(), recording.stop()])
      expect(second).toBe(first)
      expect(FakeMediaRecorder.instances).toHaveLength(1)
    })

    it('reports input loudness while recording and zero afterwards', async () => {
      const recording = await startRecording({ maxSeconds: 60 })
      expect(recording.getLevel()).toBeGreaterThan(0)
      expect(recording.getLevel()).toBeLessThanOrEqual(1)
      recording.cancel()
      expect(recording.getLevel()).toBe(0)
    })
  })

  describe('device fallback', () => {
    it.each(['OverconstrainedError', 'NotFoundError'])(
      'records from the default device when the remembered one raises %s',
      async (name) => {
        getUserMedia.mockRejectedValueOnce(domError(name))
        const recording = await startRecording({ maxSeconds: 60, deviceId: 'gone' })

        expect(getUserMedia).toHaveBeenCalledTimes(2)
        expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { echoCancellation: true, noiseSuppression: true } })
        recording.cancel()
        expect(allTracksStopped()).toBe(true)
      },
    )

    it('reports no-device when even the default device is missing', async () => {
      getUserMedia.mockRejectedValue(domError('NotFoundError'))
      await expect(startRecording({ maxSeconds: 60, deviceId: 'gone' })).rejects.toMatchObject({ code: 'no-device' })
      expect(getUserMedia).toHaveBeenCalledTimes(2)
    })

    it('does not fall back on a permission error', async () => {
      getUserMedia.mockRejectedValue(domError('NotAllowedError'))
      await expect(startRecording({ maxSeconds: 60, deviceId: 'usb-1' })).rejects.toMatchObject({ code: 'permission' })
      expect(getUserMedia).toHaveBeenCalledTimes(1)
    })
  })

  describe('capture errors', () => {
    it.each([
      ['NotAllowedError', 'permission'],
      ['SecurityError', 'permission'],
      ['NotFoundError', 'no-device'],
      ['NotReadableError', 'device-busy'],
      ['TrackStartError', 'device-busy'],
      ['TypeError', 'failed'],
    ])('maps %s to %s', async (name, code) => {
      getUserMedia.mockRejectedValue(domError(name))
      const error = await startRecording({ maxSeconds: 60 }).catch(reason => reason)

      expect(error).toBeInstanceOf(VoiceRecorderError)
      expect(error.code).toBe(code)
    })

    it('reports unavailable without touching the microphone when the API is missing', async () => {
      setSecureContext(false)
      await expect(startRecording({ maxSeconds: 60 })).rejects.toMatchObject({ code: 'unavailable' })
      expect(getUserMedia).not.toHaveBeenCalled()
    })

    it('releases the stream when the recorder cannot be constructed', async () => {
      globalThis.MediaRecorder = class {
        static isTypeSupported = () => false
        constructor() {
          throw domError('NotSupportedError')
        }
      } as unknown as typeof MediaRecorder

      await expect(startRecording({ maxSeconds: 60 })).rejects.toMatchObject({ code: 'failed' })
      expect(allTracksStopped()).toBe(true)
    })
  })

  describe('cancellation', () => {
    it('never opens the microphone when already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(startRecording({ maxSeconds: 60, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
      expect(getUserMedia).not.toHaveBeenCalled()
    })

    it('stops the stream at once when permission arrives after the abort', async () => {
      const controller = new AbortController()
      let grant!: (stream: FakeStream) => void
      getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve as typeof grant }))

      const pending = startRecording({ maxSeconds: 60, signal: controller.signal })
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()
      const stream = new FakeStream()
      streams.push(stream)
      grant(stream)

      await rejection
      expect(stream.tracks[0]!.stopped).toBe(true)
      expect(FakeMediaRecorder.instances).toHaveLength(0)
    })

    it('discards the recording and stops every track', async () => {
      const recording = await startRecording({ maxSeconds: 60 })
      recording.cancel()

      expect(allTracksStopped()).toBe(true)
      expect(audioContexts.every(context => context.closed)).toBe(true)
      expect(FakeMediaRecorder.instances[0]!.state).toBe('inactive')
    })

    it('is idempotent', async () => {
      const recording = await startRecording({ maxSeconds: 60 })
      recording.cancel()
      const stopCalls = FakeMediaRecorder.instances[0]!.stopCalls

      expect(() => recording.cancel()).not.toThrow()
      expect(FakeMediaRecorder.instances[0]!.stopCalls).toBe(stopCalls)
    })

    it('rejects stop() after a cancel instead of producing audio', async () => {
      const recording = await startRecording({ maxSeconds: 60 })
      recording.cancel()
      await expect(recording.stop()).rejects.toBeInstanceOf(VoiceRecorderError)
    })

    it('drops the result when cancelled while the recording is being decoded', async () => {
      const recording = await startRecording({ maxSeconds: 60 })
      const result = recording.stop()
      recording.cancel()
      await expect(result).rejects.toBeInstanceOf(VoiceRecorderError)
    })
  })

  describe('maxSeconds', () => {
    it('stops capturing and notifies once the cap is reached', async () => {
      vi.useFakeTimers()
      const onLimitReached = vi.fn()
      const recording = await startRecording({ maxSeconds: 3, onLimitReached })

      vi.advanceTimersByTime(2999)
      expect(onLimitReached).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)

      expect(onLimitReached).toHaveBeenCalledTimes(1)
      expect(FakeMediaRecorder.instances[0]!.state).toBe('inactive')
      vi.useRealTimers()
      decodedSeconds = 3
      await expect(recording.stop()).resolves.toMatchObject({ seconds: 3 })
    })

    it('truncates audio that overshoots the cap', async () => {
      decodedSeconds = 10
      const recording = await startRecording({ maxSeconds: 3 })
      const result = await recording.stop()

      expect(result.seconds).toBe(3)
      expect(result.wav.size).toBe(44 + 3 * 16_000 * 2)
    })

    it('does not fire the limit callback after a manual stop', async () => {
      vi.useFakeTimers()
      const onLimitReached = vi.fn()
      const recording = await startRecording({ maxSeconds: 3, onLimitReached })
      const result = recording.stop()
      await vi.runAllTimersAsync()
      await result

      expect(onLimitReached).not.toHaveBeenCalled()
    })
  })

  describe('interruption', () => {
    it('reports a track that ends mid-recording and rejects stop()', async () => {
      const onInterrupted = vi.fn()
      const recording = await startRecording({ maxSeconds: 60, onInterrupted })

      streams[0]!.tracks[0]!.end()

      expect(onInterrupted).toHaveBeenCalledTimes(1)
      expect(onInterrupted.mock.calls[0]![0]).toMatchObject({ code: 'interrupted' })
      expect(allTracksStopped()).toBe(true)
      await expect(recording.stop()).rejects.toMatchObject({ code: 'interrupted' })
    })

    it('reports a recorder error as a failure', async () => {
      const onInterrupted = vi.fn()
      const recording = await startRecording({ maxSeconds: 60, onInterrupted })

      FakeMediaRecorder.instances[0]!.dispatchEvent(new Event('error'))

      expect(onInterrupted.mock.calls[0]![0]).toMatchObject({ code: 'failed' })
      await expect(recording.stop()).rejects.toMatchObject({ code: 'failed' })
    })

    it('does not treat its own cleanup as an interruption', async () => {
      const onInterrupted = vi.fn()
      const recording = await startRecording({ maxSeconds: 60, onInterrupted })
      await recording.stop()
      streams[0]!.tracks[0]!.end()

      expect(onInterrupted).not.toHaveBeenCalled()
    })
  })

  describe('decoding', () => {
    it('turns a decode failure on a real recording into a failed error after the microphone is already off', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      decodeShouldFail = true
      const recording = await startRecording({ maxSeconds: 60 })
      vi.setSystemTime(Date.now() + 2000)

      await expect(recording.stop()).rejects.toMatchObject({ code: 'failed' })
      expect(allTracksStopped()).toBe(true)
    })

    // Chromium cannot decode the container MediaRecorder writes for a click
    // shorter than about 100 ms. That is a mis-tap, not a broken decoder.
    it('reports a click too short to decode as an empty recording, not as a failure', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      decodeShouldFail = true
      const recording = await startRecording({ maxSeconds: 60 })
      vi.setSystemTime(Date.now() + 30)

      const result = await recording.stop()

      expect(result.seconds).toBe(0)
      expect(result.wav.size).toBe(44)
      expect(allTracksStopped()).toBe(true)
    })

    it('still decodes a short click normally when the browser can', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      decodedSeconds = 0.2
      const recording = await startRecording({ maxSeconds: 60 })
      vi.setSystemTime(Date.now() + 200)

      await expect(recording.stop()).resolves.toMatchObject({ seconds: expect.closeTo(0.2, 5) })
    })
  })
})
