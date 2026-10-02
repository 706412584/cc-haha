import { encodeWav, toMono16k, VOICE_SAMPLE_RATE } from './wav'

export type VoiceRecorderErrorCode =
  | 'unavailable'
  | 'permission'
  | 'no-device'
  | 'device-busy'
  | 'interrupted'
  | 'failed'

export class VoiceRecorderError extends Error {
  readonly code: VoiceRecorderErrorCode

  constructor(code: VoiceRecorderErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'VoiceRecorderError'
    this.code = code
  }
}

export type RecordingResult = { wav: Blob; seconds: number }

export interface ActiveRecording {
  /** Input loudness in 0..1. Cheap enough to poll from requestAnimationFrame. */
  getLevel(): number
  /**
   * Ends the recording and resolves with the 16 kHz mono WAV. Repeated calls
   * share one result. Rejects with a `VoiceRecorderError` when the capture was
   * interrupted or cancelled.
   */
  stop(): Promise<RecordingResult>
  /** Discards the recording and releases the microphone. Idempotent. */
  cancel(): void
}

export type StartRecordingOptions = {
  /** Undefined, or an id that no longer exists, records from the system default. */
  deviceId?: string
  maxSeconds: number
  /**
   * The cap was reached and the recorder has already stopped capturing. The
   * caller still owns the microphone until it calls `stop()` or `cancel()`.
   */
  onLimitReached?: () => void
  /** The device vanished or the recorder failed while recording. */
  onInterrupted?: (error: VoiceRecorderError) => void
  /** Aborting before the microphone opens releases it the moment it arrives. */
  signal?: AbortSignal
}

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const RECORDER_TIMESLICE_MS = 250
const LEVEL_GAIN = 5
/**
 * MediaRecorder writes a container Chromium cannot decode when it is stopped
 * within roughly 100 ms of starting. A decode failure inside this window is a
 * mis-tap, so it is reported as an empty recording rather than a failure.
 */
const UNDECODABLE_CLICK_MS = 500

export function isVoiceCaptureSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  return Boolean(
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined',
  )
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : ''
}

function mapCaptureError(error: unknown): VoiceRecorderError {
  if (error instanceof VoiceRecorderError) return error
  const message = error instanceof Error ? error.message : undefined
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return new VoiceRecorderError('permission', message)
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new VoiceRecorderError('no-device', message)
    case 'NotReadableError':
    case 'TrackStartError':
      return new VoiceRecorderError('device-busy', message)
    default:
      return new VoiceRecorderError('failed', message)
  }
}

function abortError(): DOMException {
  return new DOMException('Recording was cancelled', 'AbortError')
}

function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // A track that is already gone has nothing left to release.
    }
  }
}

async function acquireStream(deviceId: string | undefined): Promise<MediaStream> {
  const audio = { echoCancellation: true, noiseSuppression: true }
  const { getUserMedia } = navigator.mediaDevices
  if (!deviceId) return getUserMedia.call(navigator.mediaDevices, { audio })
  try {
    return await getUserMedia.call(navigator.mediaDevices, { audio: { ...audio, deviceId: { exact: deviceId } } })
  } catch (error) {
    // A remembered microphone that was unplugged is not an error for the user;
    // record from whatever the system offers now.
    const name = errorName(error)
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw error
    return getUserMedia.call(navigator.mediaDevices, { audio })
  }
}

async function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

function createDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export async function startRecording(options: StartRecordingOptions): Promise<ActiveRecording> {
  if (!isVoiceCaptureSupported()) throw new VoiceRecorderError('unavailable')
  if (options.signal?.aborted) throw abortError()

  let stream: MediaStream
  try {
    stream = await acquireStream(options.deviceId)
  } catch (error) {
    throw mapCaptureError(error)
  }
  // Permission prompts outlive the click that caused them. If the caller gave
  // up while the prompt was open, the stream must not stay live behind them.
  if (options.signal?.aborted) {
    stopStream(stream)
    throw abortError()
  }

  let recorder: MediaRecorder
  try {
    const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
      ? MIME_CANDIDATES.find(candidate => MediaRecorder.isTypeSupported(candidate))
      : undefined
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (error) {
    stopStream(stream)
    throw mapCaptureError(error)
  }

  const tracks = stream.getTracks()
  const chunks: Blob[] = []
  const recorderStopped = createDeferred()
  let cancelled = false
  let released = false
  let failure: VoiceRecorderError | null = null
  let stopPromise: Promise<RecordingResult> | null = null
  let startedAt = 0
  let limitTimer: ReturnType<typeof setTimeout> | undefined
  let audioContext: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let analyser: AnalyserNode | undefined
  let levelBuffer: Float32Array<ArrayBuffer> | undefined

  const onData = (event: Event) => {
    const data = (event as BlobEvent).data
    if (data && data.size > 0) chunks.push(data)
  }
  const onRecorderStop = () => recorderStopped.resolve()
  const onRecorderError = () => interrupt(new VoiceRecorderError('failed', 'The recorder reported an error'))
  const onTrackEnded = () => interrupt(new VoiceRecorderError('interrupted', 'The microphone stopped delivering audio'))

  const release = () => {
    if (released) return
    released = true
    clearTimeout(limitTimer)
    recorder.removeEventListener('dataavailable', onData)
    recorder.removeEventListener('stop', onRecorderStop)
    recorder.removeEventListener('error', onRecorderError)
    for (const track of tracks) track.removeEventListener('ended', onTrackEnded)
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // Already stopping.
      }
    }
    stopStream(stream)
    try {
      source?.disconnect()
    } catch {
      // Not connected.
    }
    if (audioContext && audioContext.state !== 'closed') void audioContext.close().catch(() => {})
  }

  function interrupt(error: VoiceRecorderError) {
    if (released || cancelled || failure) return
    failure = error
    release()
    recorderStopped.resolve()
    options.onInterrupted?.(error)
  }

  recorder.addEventListener('dataavailable', onData)
  recorder.addEventListener('stop', onRecorderStop)
  recorder.addEventListener('error', onRecorderError)
  for (const track of tracks) track.addEventListener('ended', onTrackEnded)

  try {
    // The level meter is a nicety; a browser without it still records.
    audioContext = new AudioContext()
    source = audioContext.createMediaStreamSource(stream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    levelBuffer = new Float32Array(analyser.fftSize)
    void audioContext.resume?.()?.catch(() => {})
  } catch {
    analyser = undefined
  }

  try {
    recorder.start(RECORDER_TIMESLICE_MS)
    startedAt = Date.now()
  } catch (error) {
    release()
    throw mapCaptureError(error)
  }

  limitTimer = setTimeout(() => {
    if (released || cancelled || failure) return
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        // Already stopping.
      }
    }
    options.onLimitReached?.()
  }, options.maxSeconds * 1000)

  const finalize = async (): Promise<RecordingResult> => {
    const elapsedMs = Date.now() - startedAt
    if (!cancelled && !failure && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch (error) {
        interrupt(mapCaptureError(error))
      }
    }
    await recorderStopped.promise
    if (cancelled) throw new VoiceRecorderError('failed', 'Recording was cancelled')
    if (failure) throw failure

    const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || '' })
    // Turn the microphone off before the slow part.
    release()

    let samples: Float32Array
    try {
      const decoder = new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE)
      const decoded = await decoder.decodeAudioData(await readBlob(blob))
      samples = await toMono16k(decoded)
    } catch (error) {
      if (elapsedMs < UNDECODABLE_CLICK_MS) return { wav: encodeWav(new Float32Array(0)), seconds: 0 }
      throw new VoiceRecorderError('failed', error instanceof Error ? error.message : 'Could not decode the recording')
    }
    if (cancelled) throw new VoiceRecorderError('failed', 'Recording was cancelled')

    const maxSamples = Math.floor(options.maxSeconds * VOICE_SAMPLE_RATE)
    if (samples.length > maxSamples) samples = samples.subarray(0, maxSamples)
    return { wav: encodeWav(samples), seconds: samples.length / VOICE_SAMPLE_RATE }
  }

  return {
    getLevel() {
      if (!analyser || !levelBuffer || released) return 0
      analyser.getFloatTimeDomainData(levelBuffer)
      let sum = 0
      for (let i = 0; i < levelBuffer.length; i += 1) sum += levelBuffer[i]! * levelBuffer[i]!
      return Math.min(1, Math.sqrt(sum / levelBuffer.length) * LEVEL_GAIN)
    },
    stop() {
      stopPromise ??= finalize()
      return stopPromise
    },
    cancel() {
      if (cancelled) return
      cancelled = true
      release()
      recorderStopped.resolve()
    },
  }
}
