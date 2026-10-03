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
  /** The scanner's own explanation of its verdict, when it gives one. */
  summary?: string
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
  /** Editor's pick in the curated catalog. */
  featured?: boolean
  /**
   * The entry is (or matches) a curated catalog skill. Only then is `category`
   * a catalog category key; otherwise it is SkillHub's raw category string.
   */
  curated?: boolean
  /** Original upstream summary, for non-Chinese readers (`summary` is zh-CN for curated skills). */
  summaryEn?: string
  /** Why a curated skill ships despite a flagged verdict. */
  securityNote?: string
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
  /** Release note of the latest version, when upstream has a meaningful one. */
  changelog?: { version?: string; text: string; publishedAt?: number }
  /** The skill's page on its registry website. */
  pageUrl?: string
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

/**
 * `catalog`: the curated snapshot shipped with the app (no network).
 * `market`: live list/search across both upstream registries.
 */
export type MarketScope = 'catalog' | 'market'

export type MarketCategory = {
  key: string
  /** zh-CN display name */
  name: string
  nameEn: string
  /** Skills in this category across the whole catalog (static, not filtered). */
  count: number
}

export type MarketListResponse = {
  items: NormalizedSkill[]
  nextCursor: string | null
  sources: Record<MarketSource, SourceStatusInfo>
  scope?: MarketScope
  /** Catalog scope: matching skills across all pages. */
  total?: number
  /** Catalog scope: category bar entries. */
  categories?: MarketCategory[]
  /** Catalog scope: epoch millis of the upstream reads behind the snapshot. */
  catalogGeneratedAt?: number
}

export type MarketSourceFilter = 'all' | MarketSource
export type MarketSecurityFilter = 'all' | SecurityStatus
export type MarketInstalledFilter = 'all' | 'installed' | 'installable'
