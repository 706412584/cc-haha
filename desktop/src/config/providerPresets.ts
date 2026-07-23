import providerPresetsJson from '../../../src/server/config/providerPresets.json'
import type { ProviderPreset } from '../types/providerPreset'

// Presets ship with the desktop bundle. Provider creation must remain available
// even when the local HTTP control plane is temporarily unavailable.
export const BUNDLED_PROVIDER_PRESETS = providerPresetsJson as ProviderPreset[]
