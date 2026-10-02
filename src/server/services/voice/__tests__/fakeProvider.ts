import type {
  SpeechProvider,
  VoiceLanguage,
  VoicePreferences,
  VoicePreparationState,
  VoiceProviderInfo,
} from '../types.js'
import { DEFAULT_VOICE_PREFERENCES } from '../types.js'
import type { VoicePreferencesStore } from '../preferencesStore.js'

export const SAMPLE_RATE = 16_000

const UNSUPPORTED_STATE = {
  phase: 'failed',
  error: { reason: 'unsupported-platform', message: 'not available on this platform' },
} as const satisfies VoicePreparationState

/** Builds a canonical 44-byte-header PCM16 mono 16 kHz WAV of the given duration. */
export function makeWav(seconds: number, overrides: {
  channels?: number
  sampleRate?: number
  bits?: number
  format?: number
  dataLength?: number
  riff?: string
  wave?: string
} = {}): Uint8Array {
  const dataBytes = Math.round(seconds * SAMPLE_RATE) * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let index = 0; index < 4; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, overrides.riff ?? 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  text(8, overrides.wave ?? 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, overrides.format ?? 1, true)
  view.setUint16(22, overrides.channels ?? 1, true)
  view.setUint32(24, overrides.sampleRate ?? SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, overrides.bits ?? 16, true)
  text(36, 'data')
  view.setUint32(40, overrides.dataLength ?? dataBytes, true)
  return bytes
}

export type FakeProviderOptions = {
  id: string
  name?: string
  languages?: VoiceLanguage[]
  location?: VoiceProviderInfo['location']
  /** Omit to model a provider that needs no local assets. */
  needsAssets?: boolean
  /** Models a provider on a platform it has no runtime for. */
  unsupported?: boolean
  text?: string
}

/**
 * Deterministic provider. `prepare()` blocks until `finishPrepare()` or
 * `failPrepare()` is called (or the signal aborts), so tests can observe the
 * in-flight state.
 */
export class FakeProvider implements SpeechProvider {
  readonly info: VoiceProviderInfo
  readonly preparation?: SpeechProvider['preparation']
  installed = false
  prepareCalls = 0
  /** Options passed to each prepare() call, in order. */
  prepareOptions: Array<Parameters<NonNullable<SpeechProvider['preparation']>['prepare']>[2]> = []
  removeCalls = 0
  transcribeCalls: Array<{ bytes: number; language: VoiceLanguage }> = []
  transcribeError?: Error
  /** When set, an aborted prepare() keeps running until releaseAbort() is called. */
  holdAbort = false
  private abortRelease: Array<() => void> = []
  private readonly text: string
  private resolvePrepare?: () => void
  private rejectPrepare?: (error: Error) => void
  private reportFn?: (state: VoicePreparationState) => void
  /** Resolves once prepare() has been entered. */
  started: Promise<void>
  private markStarted!: () => void

  constructor(options: FakeProviderOptions) {
    this.info = {
      id: options.id,
      name: options.name ?? options.id,
      location: options.location ?? 'local',
      languages: options.languages ?? ['auto', 'zh', 'en'],
      downloadBytes: 1000,
    }
    this.text = options.text ?? `transcript from ${options.id}`
    this.started = new Promise(resolve => { this.markStarted = resolve })
    if (options.needsAssets !== false) {
      this.preparation = {
        status: async () => options.unsupported
          ? UNSUPPORTED_STATE
          : this.installed ? { phase: 'ready' } : { phase: 'unprepared' },
        prepare: options.unsupported
          ? async (_signal, report) => {
            report(UNSUPPORTED_STATE)
            throw new Error(UNSUPPORTED_STATE.error.message)
          }
          : (signal, report, prepareOptions) => {
            this.prepareOptions.push(prepareOptions)
            return this.runPrepare(signal, report)
          },
        remove: async () => {
          this.removeCalls += 1
          this.installed = false
        },
      }
    }
  }

  private runPrepare(signal: AbortSignal, report: (state: VoicePreparationState) => void): Promise<void> {
    this.prepareCalls += 1
    this.reportFn = report
    this.markStarted()
    return new Promise<void>((resolve, reject) => {
      this.resolvePrepare = () => {
        this.installed = true
        resolve()
      }
      this.rejectPrepare = reject
      signal.addEventListener('abort', () => {
        if (this.holdAbort) this.abortRelease.push(() => reject(new Error('aborted')))
        else reject(new Error('aborted'))
      }, { once: true })
    })
  }

  report(state: VoicePreparationState): void {
    this.reportFn?.(state)
  }

  finishPrepare(): void {
    this.resolvePrepare?.()
  }

  releaseAbort(): void {
    for (const release of this.abortRelease.splice(0)) release()
  }

  failPrepare(error: Error): void {
    this.rejectPrepare?.(error)
  }

  /** Makes the next prepare() cycle observable again. */
  resetStarted(): void {
    this.started = new Promise(resolve => { this.markStarted = resolve })
  }

  async transcribe(wav: Uint8Array, options: { language: VoiceLanguage }) {
    this.transcribeCalls.push({ bytes: wav.byteLength, language: options.language })
    if (this.transcribeError) throw this.transcribeError
    return { text: this.text, audioSeconds: 0, inferenceSeconds: 0.25 }
  }
}

export function memoryPreferencesStore(initial: Partial<VoicePreferences> = {}): VoicePreferencesStore & {
  current: VoicePreferences
} {
  const store = {
    current: { ...DEFAULT_VOICE_PREFERENCES, ...initial } as VoicePreferences,
    async read() {
      return { ...store.current }
    },
    async update(patch: Partial<VoicePreferences>) {
      store.current = { ...store.current, ...patch }
      return { ...store.current }
    },
  }
  return store
}
