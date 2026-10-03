import type { SpeechProvider } from './types.js'

/**
 * Provider registry: a plain Map keyed by `info.id`. There is deliberately no
 * fallback chain — a request names the provider it wants, or the saved
 * preference does.
 */
export class VoiceProviderRegistry {
  private readonly providers = new Map<string, SpeechProvider>()

  register(provider: SpeechProvider): this {
    const id = provider.info.id
    if (this.providers.has(id)) {
      throw new Error(`Voice provider already registered: ${id}`)
    }
    this.providers.set(id, provider)
    return this
  }

  get(id: string): SpeechProvider | undefined {
    return this.providers.get(id)
  }

  list(): SpeechProvider[] {
    return [...this.providers.values()]
  }
}
