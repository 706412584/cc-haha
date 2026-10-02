import { createDesktopUiVoicePreferencesStore } from './preferencesStore.js'
import { VoiceProviderRegistry } from './registry.js'
import { createSenseVoiceProvider } from './sensevoice/index.js'
import type { SpeechProvider } from './types.js'
import { VoiceService, type VoiceServiceOptions } from './voiceService.js'

/**
 * Providers shipped with the server. Adding a provider means adding one
 * factory here; nothing else in the voice service or API changes.
 */
export function createDefaultProviders(): SpeechProvider[] {
  return [createSenseVoiceProvider()]
}

export function createVoiceService(
  providers: SpeechProvider[],
  options: Partial<Omit<VoiceServiceOptions, 'registry'>> = {},
): VoiceService {
  const registry = new VoiceProviderRegistry()
  for (const provider of providers) registry.register(provider)
  return new VoiceService({
    registry,
    preferences: options.preferences ?? createDesktopUiVoicePreferencesStore(),
  })
}

let instance: VoiceService | undefined

/** Process-wide service used by the HTTP API. Providers are created on first use. */
export function getVoiceService(): VoiceService {
  instance ??= createVoiceService(createDefaultProviders())
  return instance
}

/** Test seam: drop the cached service so the next call rebuilds it. */
export function resetVoiceServiceForTests(): void {
  instance = undefined
}
