import providerPresetsJson from '../../../src/server/config/providerPresets.json'
import type { ProviderPreset } from '../types/providerPreset'

// Presets ship with the desktop bundle. Provider creation must remain available
// even when the local HTTP control plane is temporarily unavailable.
// Keeps retired presets so an existing provider's presetId still resolves — the edit
// form reads the preset for its name badge and for any field the record itself never
// persisted (defaultEnv always; authStrategy / modelContextWindows on older records).
export const BUNDLED_PROVIDER_PRESETS = providerPresetsJson as ProviderPreset[]

/**
 * Presets a user may pick when adding a provider. Retired ones are dropped here
 * rather than deleted from the bundle, so already-configured providers are untouched.
 */
export function selectableProviderPresets(presets: ProviderPreset[]): ProviderPreset[] {
  return presets.filter((preset) => !preset.deprecated)
}

export function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase()
}

/** Match a preset's primary or region-specific endpoint to an imported configuration. */
export function presetMatchesBaseUrl(preset: ProviderPreset, baseUrl: string): boolean {
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl)
  return [preset.baseUrl, ...(preset.regionalEndpoints?.map((endpoint) => endpoint.baseUrl) ?? [])]
    .some((endpoint) => normalizeProviderBaseUrl(endpoint) === normalizedBaseUrl)
}
