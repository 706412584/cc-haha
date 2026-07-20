export type RuleSource = 'claude' | 'cursor' | 'windsurf' | 'copilot'

export type RuleImportDecision = 'session' | 'persistent' | 'ignore'

export type RuleProvenance = {
  provider: string
  label: string
}

export type NormalizedProjectRule = {
  source: RuleSource
  ruleId: string
  originalPath: string
  canonicalPath: string
  fingerprint: string
  isNative: boolean
  applicability: 'always' | 'conditional' | 'manual'
  scopes: string[]
  tags: string[]
  provenance: RuleProvenance
  decision?: RuleImportDecision
  status: 'active' | 'duplicate' | 'conflict' | 'overridden-by-native'
  relatedRulePaths: string[]
}

export interface RuleSourceAdapter {
  readonly source: RuleSource
  discover(projectPath: string): Promise<NormalizedProjectRule[]>
}
