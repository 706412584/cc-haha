import { ApiError } from '../../middleware/errorHandler.js'
import { VoiceServiceError } from './errors.js'
import { isVoiceDownloadSource, isVoiceLanguage } from './preferences.js'
import type { VoicePreferencesStore } from './preferencesStore.js'
import type { VoiceProviderRegistry } from './registry.js'
import {
  VOICE_LIMITS,
  type SpeechProvider,
  type VoiceCatalog,
  type VoiceLanguage,
  type VoicePreferences,
  type VoicePreparationState,
  type VoiceProviderStatus,
  type VoiceTranscript,
} from './types.js'
import { validateVoiceWav } from './wav.js'

export type VoiceServiceOptions = {
  registry: VoiceProviderRegistry
  preferences: VoicePreferencesStore
}

type PrepareTask = {
  controller: AbortController
  state: VoicePreparationState
  /** Settles once the provider's prepare() has fully stopped, even after cancel. */
  settled: Promise<void>
}

function isUnsupportedPlatform(state: VoicePreparationState): boolean {
  return state.phase === 'failed' && state.error?.reason === 'unsupported-platform'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function providerLanguage(provider: SpeechProvider, preferred: VoiceLanguage): VoiceLanguage {
  const { languages } = provider.info
  if (languages.includes(preferred)) return preferred
  return languages.includes('auto') ? 'auto' : (languages[0] ?? 'auto')
}

export class VoiceService {
  private readonly registry: VoiceProviderRegistry
  private readonly preferences: VoicePreferencesStore
  private readonly tasks = new Map<string, PrepareTask>()
  /** Last failed/cancelled outcome per provider; disk state alone would read as `unprepared`. */
  private readonly outcomes = new Map<string, VoicePreparationState>()
  /** Cancelled tasks whose provider.prepare() has not stopped yet. */
  private readonly winding = new Map<string, Promise<void>>()

  constructor(options: VoiceServiceOptions) {
    this.registry = options.registry
    this.preferences = options.preferences
  }

  private requireProvider(id: string): SpeechProvider {
    const provider = this.registry.get(id)
    if (!provider) {
      throw new VoiceServiceError('voice/unknown-provider', `Unknown voice provider: ${id}`)
    }
    return provider
  }

  private async providerPreparation(provider: SpeechProvider): Promise<VoicePreparationState> {
    const task = this.tasks.get(provider.info.id)
    if (task) return task.state
    if (!provider.preparation) return { phase: 'ready' }
    const onDisk = await provider.preparation.status()
    if (onDisk.phase === 'ready') {
      this.outcomes.delete(provider.info.id)
      return onDisk
    }
    return this.outcomes.get(provider.info.id) ?? onDisk
  }

  private async providerStatus(provider: SpeechProvider): Promise<VoiceProviderStatus> {
    return { info: provider.info, preparation: await this.providerPreparation(provider) }
  }

  async catalog(): Promise<VoiceCatalog> {
    const providers = await Promise.all(this.registry.list().map(provider => this.providerStatus(provider)))
    return {
      // Providers report `unsupported-platform` themselves; the feature is only
      // unavailable when every one of them does.
      supported: providers.some(item => !isUnsupportedPlatform(item.preparation)),
      providers,
      preferences: await this.preferences.read(),
      limits: VOICE_LIMITS,
    }
  }

  async status(providerId: string): Promise<VoiceProviderStatus> {
    return this.providerStatus(this.requireProvider(providerId))
  }

  async updatePreferences(patch: unknown): Promise<VoicePreferences> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw ApiError.badRequest('Voice preferences must be an object')
    }
    const input = patch as Record<string, unknown>
    const next: Partial<VoicePreferences> = {}

    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw ApiError.badRequest('enabled must be a boolean')
      next.enabled = input.enabled
    }
    if (input.providerId !== undefined) {
      if (typeof input.providerId !== 'string' || !this.registry.get(input.providerId)) {
        throw new VoiceServiceError('voice/unknown-provider', `Unknown voice provider: ${String(input.providerId)}`)
      }
      next.providerId = input.providerId
    }
    if (input.language !== undefined) {
      if (!isVoiceLanguage(input.language)) throw ApiError.badRequest(`Unsupported language: ${String(input.language)}`)
      next.language = input.language
    }
    if (input.downloadSource !== undefined) {
      if (!isVoiceDownloadSource(input.downloadSource)) {
        throw ApiError.badRequest(`Unsupported download source: ${String(input.downloadSource)}`)
      }
      next.downloadSource = input.downloadSource
    }

    const current = await this.preferences.read()
    const provider = this.requireProvider(next.providerId ?? current.providerId)
    if (next.language !== undefined) {
      if (!provider.info.languages.includes(next.language)) {
        throw ApiError.badRequest(`${provider.info.name} does not support language: ${next.language}`)
      }
    } else if (next.providerId !== undefined && !provider.info.languages.includes(current.language)) {
      // Switching provider must not leave a language the new provider cannot serve.
      next.language = providerLanguage(provider, current.language)
    }

    return this.preferences.update(next)
  }

  /** Starts (or joins) the background download for a provider; returns immediately. */
  async prepare(providerId: string): Promise<VoiceProviderStatus> {
    const provider = this.requireProvider(providerId)
    const preparation = provider.preparation
    if (!preparation || this.tasks.has(providerId)) {
      return this.providerStatus(provider)
    }

    this.outcomes.delete(providerId)
    const controller = new AbortController()
    const task: PrepareTask = {
      controller,
      state: { phase: 'downloading' },
      settled: Promise.resolve(),
    }
    this.tasks.set(providerId, task)
    task.settled = this.runPrepare(provider, task)
    return { info: provider.info, preparation: task.state }
  }

  private async runPrepare(provider: SpeechProvider, task: PrepareTask): Promise<void> {
    const id = provider.info.id
    const preparation = provider.preparation!
    const isCurrent = () => this.tasks.get(id) === task
    let final: VoicePreparationState

    try {
      await this.winding.get(id)
      if (task.controller.signal.aborted) return
      const onDisk = await preparation.status()
      if (onDisk.phase === 'ready') {
        final = onDisk
      } else {
        const { downloadSource } = await this.preferences.read()
        await preparation.prepare(task.controller.signal, state => {
          if (isCurrent()) task.state = state
        }, { downloadSource })
        const after = await preparation.status()
        if (after.phase === 'ready') {
          final = after
        } else if (task.state.phase === 'failed') {
          final = task.state
        } else {
          final = {
            phase: 'failed',
            error: { reason: 'unknown', message: 'Preparation finished but the assets are not ready' },
          }
        }
      }
    } catch (error) {
      if (task.controller.signal.aborted) {
        final = { phase: 'cancelled' }
      } else if (task.state.phase === 'failed') {
        final = task.state
      } else {
        final = { phase: 'failed', error: { reason: 'unknown', message: describeError(error) } }
      }
    }

    // A cancel or remove already retired this task; its outcome is recorded there.
    if (!isCurrent()) return
    this.tasks.delete(id)
    if (final.phase === 'ready') this.outcomes.delete(id)
    else this.outcomes.set(id, final)
  }

  async cancel(providerId: string): Promise<VoiceProviderStatus> {
    const provider = this.requireProvider(providerId)
    const task = this.tasks.get(providerId)
    if (task) {
      this.tasks.delete(providerId)
      this.outcomes.set(providerId, { phase: 'cancelled' })
      task.controller.abort()
      // Keep a later prepare()/remove() from racing the winding-down download.
      const winding: Promise<void> = task.settled.finally(() => {
        if (this.winding.get(providerId) === winding) this.winding.delete(providerId)
      })
      this.winding.set(providerId, winding)
    }
    return this.providerStatus(provider)
  }

  async removeAssets(providerId: string): Promise<VoiceProviderStatus> {
    const provider = this.requireProvider(providerId)
    await this.cancel(providerId)
    await this.winding.get(providerId)
    this.outcomes.delete(providerId)
    if (provider.preparation) {
      const removing = provider.preparation.remove()
      // A prepare() arriving mid-removal must wait for it; otherwise its fresh
      // download would be deleted underneath it (or leave a half-removed tree).
      const winding: Promise<void> = removing
        .then(() => {}, () => {})
        .finally(() => {
          if (this.winding.get(providerId) === winding) this.winding.delete(providerId)
        })
      this.winding.set(providerId, winding)
      try {
        await removing
      } catch (error) {
        throw new VoiceServiceError('voice/failed', `Failed to remove voice assets: ${describeError(error)}`)
      }
    }
    return this.providerStatus(provider)
  }

  async transcribe(
    providerId: string | undefined,
    wav: Uint8Array,
    language: VoiceLanguage | undefined,
    signal: AbortSignal,
  ): Promise<VoiceTranscript> {
    const preferences = await this.preferences.read()
    const provider = this.requireProvider(providerId ?? preferences.providerId)
    if (language !== undefined && !provider.info.languages.includes(language)) {
      throw ApiError.badRequest(`${provider.info.name} does not support language: ${language}`)
    }
    const effectiveLanguage = language ?? providerLanguage(provider, preferences.language)

    const { audioSeconds } = validateVoiceWav(wav)

    const preparation = await this.providerPreparation(provider)
    if (preparation.phase !== 'ready') {
      throw new VoiceServiceError('voice/not-ready', `${provider.info.name} is not ready (${preparation.phase})`)
    }

    try {
      const transcript = await provider.transcribe(wav, { language: effectiveLanguage }, signal)
      return { ...transcript, audioSeconds }
    } catch (error) {
      if (signal.aborted) throw error
      // Providers classify their own failures (invalid audio, model removed
      // after the readiness check); wrapping those would turn a 400/409 into 500.
      if (error instanceof VoiceServiceError) throw error
      throw new VoiceServiceError('voice/failed', `Transcription failed: ${describeError(error)}`)
    }
  }
}
