import type { ApiFormat, ProviderAuthStrategy } from './provider'

export type ModelMapping = {
  main: string
  fable?: string
  haiku: string
  sonnet: string
  opus: string
}

export type ProviderRegionalEndpoint = {
  region: string
  baseUrl: string
}

export type ProviderPreset = {
  id: string
  name: string
  baseUrl: string
  regionalEndpoints?: ProviderRegionalEndpoint[]
  apiFormat: ApiFormat
  defaultModels: ModelMapping
  needsApiKey: boolean
  websiteUrl: string
  apiKeyUrl?: string
  promoText?: string
  featured?: boolean
  /** Retired preset: hidden from the "add provider" choices, still resolves saved providers. */
  deprecated?: boolean
  authStrategy?: ProviderAuthStrategy
  defaultEnv?: Record<string, string>
  modelContextWindows?: Record<string, number>
}
