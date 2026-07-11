export type MarketSource = 'clawhub' | 'skillhub'

export const MARKET_SOURCES: MarketSource[] = ['clawhub', 'skillhub']

export type SecurityStatus = 'verified' | 'benign' | 'unknown' | 'flagged'

export type InstallState = 'installed' | 'installable' | 'not-installable'

export type SourceHealthStatus = 'ok' | 'degraded' | 'failed' | 'cached'

export type NotInstallableReason =
  | 'empty-file-list'
  | 'file-too-large'
  | 'too-many-files'
  | 'invalid-name'
  | 'name-conflict'
  | 'source-unavailable'

export type SecurityReport = {
  vendor: string
  status: string
  statusText: string
  reportUrl?: string
}

export type NormalizedSkill = {
  id: string
  source: MarketSource
  slug: string
  name: string
  summary: string
  author: { handle: string; displayName?: string; avatarUrl?: string }
  stats: { downloads: number; installs?: number; stars?: number }
  tags: string[]
  category?: string
  version?: string
  updatedAt?: number
  iconUrl?: string
  securityStatus: SecurityStatus
  securityReports?: SecurityReport[]
  requiresApiKey?: boolean
  verified?: boolean
  upstream?: { source: MarketSource; slug: string }
  mirrors?: string[]
  installState: InstallState
  notInstallableReason?: NotInstallableReason
  installedInfo?: { version?: string; installedAt?: string; dirName: string }
}

export type MarketFileMeta = {
  path: string
  size: number
  sha256?: string
  contentType?: string
  language: string
  tooBig: boolean
}

export type NormalizedSkillDetail = NormalizedSkill & {
  description: string
  descriptionFrontmatter?: Record<string, unknown>
  license?: string
  files: MarketFileMeta[]
  totalSize: number
}

export type MarketFileContent = {
  path: string
  content: string
  language: string
  size: number
  truncated: boolean
}

export type SourceStatusInfo = {
  status: SourceHealthStatus
  fetchedAt?: number
  fromCache?: boolean
  error?: string
}

export type MarketListResponse = {
  items: NormalizedSkill[]
  nextCursor: string | null
  sources: Record<MarketSource, SourceStatusInfo>
}

export type MarketSourceFilter = 'all' | MarketSource
export type MarketSecurityFilter = 'all' | SecurityStatus
export type MarketInstalledFilter = 'all' | 'installed' | 'installable'
