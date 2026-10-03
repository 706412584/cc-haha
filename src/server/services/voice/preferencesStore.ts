import { DesktopUiPreferencesService } from '../desktopUiPreferencesService.js'
import type { VoicePreferences } from './types.js'

/** Where voiceService keeps the user's voice-input choices. Injected for tests. */
export interface VoicePreferencesStore {
  read(): Promise<VoicePreferences>
  update(patch: Partial<VoicePreferences>): Promise<VoicePreferences>
}

/** Persists preferences in the `voiceInput` section of `cc-haha/desktop-ui.json`. */
export function createDesktopUiVoicePreferencesStore(
  service: DesktopUiPreferencesService = new DesktopUiPreferencesService(),
): VoicePreferencesStore {
  return {
    async read() {
      return (await service.readPreferences()).preferences.voiceInput
    },
    async update(patch) {
      return (await service.updateVoiceInputPreferences(patch)).voiceInput
    },
  }
}
