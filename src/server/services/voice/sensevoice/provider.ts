/**
 * Local SenseVoice Small (INT8) speech provider.
 *
 * The runtime (sherpa-onnx) and the model are downloaded into the data
 * directory on demand, so the installer stays small. Recognition runs in a
 * separate worker process that is started on demand and reclaimed when idle.
 */
import { join } from 'node:path'
import { getNetworkProxyFetchOptions, loadNetworkSettings } from '../../networkSettings.js'
import type { DownloadOptions, FetchLike } from '../download/index.js'
import { VoiceServiceError } from '../errors.js'
import {
  VOICE_LIMITS,
  type SpeechProvider,
  type VoiceLanguage,
  type VoicePreparationState,
  type VoiceProviderInfo,
  type VoiceTranscript,
} from '../types.js'
import {
  installItems,
  resolveRuntimePlatform,
  totalDownloadBytes,
  type InstallItem,
} from './assets.js'
import {
  bytesOnDisk,
  failureState,
  installAll,
  isInstalled,
  removeInstall,
  type ExtractArchive,
} from './install.js'
import { defaultVoiceDataRoot, senseVoiceLayout, type SenseVoiceLayout } from './layout.js'
import type { WorkerConfig } from './protocol.js'
import { SenseVoiceRecognizer, type SpawnWorker } from './recognizer.js'

export const SENSEVOICE_PROVIDER_ID = 'sensevoice-local'

export interface SenseVoiceProviderOptions {
  /** Defaults to `<config dir>/cc-haha/voice`. */
  dataRoot?: string
  fetch?: FetchLike
  /** Extra fetch options per URL (proxy). Defaults to the configured network proxy. */
  fetchOptions?: DownloadOptions['fetchOptions']
  sleep?: DownloadOptions['sleep']
  /** Idle time before the worker is stopped. Default 300000. */
  idleTimeoutMs?: number
  spawnWorker?: SpawnWorker
  /** Override for tests; defaults to the running process platform. */
  platform?: { platform: NodeJS.Platform; arch: string }
  /** Replaces the pinned asset list (tests use local fixtures). */
  items?: InstallItem[]
  extract?: ExtractArchive
  threads?: number
  startupTimeoutMs?: number
  inferenceTimeoutMs?: number
  /** Download tuning: retries, backoff, probe/idle timeouts, progress interval. */
  download?: Pick<DownloadOptions, 'maxRetries' | 'backoffMs' | 'maxBackoffMs' | 'probeTimeoutMs' | 'idleTimeoutMs' | 'progressIntervalMs'>
}

export interface SenseVoiceProvider extends SpeechProvider {
  readonly preparation: NonNullable<SpeechProvider['preparation']>
  /** Stops the worker process and rejects new work. */
  dispose(): Promise<void>
}

const LANGUAGES: VoiceLanguage[] = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']

async function proxyFetchOptions(url: string): Promise<Record<string, unknown>> {
  try {
    return getNetworkProxyFetchOptions(await loadNetworkSettings(), url) as Record<string, unknown>
  } catch {
    // Proxy settings unavailable: fall back to a direct request.
    return {}
  }
}

export function createSenseVoiceProvider(options: SenseVoiceProviderOptions = {}): SenseVoiceProvider {
  const dataRoot = options.dataRoot ?? defaultVoiceDataRoot()
  const layout: SenseVoiceLayout = senseVoiceLayout(dataRoot)
  const runtimePlatform = resolveRuntimePlatform(options.platform?.platform, options.platform?.arch)
  const items = options.items ?? installItems(runtimePlatform)
  const supported = options.items !== undefined || runtimePlatform !== undefined
  const totalBytes = totalDownloadBytes(items)

  const info: VoiceProviderInfo = {
    id: SENSEVOICE_PROVIDER_ID,
    name: 'SenseVoice Small (INT8)',
    location: 'local',
    languages: LANGUAGES,
    downloadBytes: totalBytes,
  }

  const unsupportedState = (): VoicePreparationState => ({
    phase: 'failed',
    error: {
      reason: 'unsupported-platform',
      message: `Local speech recognition is not available on ${options.platform?.platform ?? process.platform}-${options.platform?.arch ?? process.arch}`,
    },
  })

  const fetchOptions = options.fetchOptions ?? (options.fetch ? undefined : proxyFetchOptions)
  const downloadOptions: DownloadOptions = {
    ...options.download,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(fetchOptions ? { fetchOptions } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }

  const modelPath = (name: string): string => join(layout.models, name)
  const recognizer = new SenseVoiceRecognizer({
    cwd: layout.base,
    idleTimeoutMs: options.idleTimeoutMs,
    startupTimeoutMs: options.startupTimeoutMs,
    inferenceTimeoutMs: options.inferenceTimeoutMs,
    spawnWorker: options.spawnWorker,
    workerConfig: (): WorkerConfig => ({
      runtimeRoot: layout.runtimeRoot,
      model: modelPath('model.int8.onnx'),
      tokens: modelPath('tokens.txt'),
      vad: modelPath('silero_vad.onnx'),
      threads: options.threads ?? 2,
      maxAudioBytes: VOICE_LIMITS.maxAudioBytes,
      vadThreshold: 0.5,
      minSilenceSeconds: 0.5,
      minSpeechSeconds: 0.25,
      segmentSeconds: 30,
    }),
  })

  let preparing = false

  const status = async (): Promise<VoicePreparationState> => {
    if (!supported) return unsupportedState()
    if (await isInstalled(layout, items)) return { phase: 'ready' }
    const completedBytes = await bytesOnDisk(layout, items)
    return completedBytes > 0
      ? { phase: 'unprepared', completedBytes, totalBytes }
      : { phase: 'unprepared' }
  }

  const prepare: SenseVoiceProvider['preparation']['prepare'] = async (signal, report, prepareOptions) => {
    if (!supported) {
      const state = unsupportedState()
      report(state)
      throw new VoiceServiceError('voice/failed', state.error!.message)
    }
    if (preparing) throw new Error('Speech preparation is already running')
    preparing = true
    let latest: VoicePreparationState = { phase: 'downloading' }
    const track = (state: VoicePreparationState): void => {
      latest = state
      report(state)
    }
    try {
      // Install targets and digests do not depend on the source, only the URLs do.
      const sourceItems = options.items ?? installItems(runtimePlatform, prepareOptions?.downloadSource)
      await installAll({ layout, items: sourceItems, download: downloadOptions, extract: options.extract }, signal, track)
      report({ phase: 'ready' })
    } catch (error) {
      if (signal.aborted) {
        report({
          phase: 'cancelled',
          ...(latest.completedBytes !== undefined ? { completedBytes: latest.completedBytes } : {}),
          totalBytes,
        })
        throw error
      }
      const state = failureState(error, {
        step: latest.step,
        resource: latest.resource,
        completedBytes: latest.completedBytes,
        totalBytes,
      })
      report(state)
      throw error
    } finally {
      preparing = false
    }
  }

  return {
    info,
    preparation: {
      status,
      prepare,
      async remove() {
        await recognizer.stopWorker()
        await removeInstall(layout)
      },
    },
    async transcribe(wav, { language }, signal): Promise<VoiceTranscript> {
      if (!supported || !await isInstalled(layout, items)) {
        throw new VoiceServiceError('voice/not-ready', 'Speech model is not downloaded yet')
      }
      return recognizer.transcribe(wav, language, signal)
    },
    dispose: () => recognizer.dispose(),
  }
}
