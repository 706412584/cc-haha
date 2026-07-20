import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  NormalizedProjectRule,
  RuleImportDecision,
  RuleSource,
  RuleSourceAdapter,
} from '../types/projectRules.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { parseFrontmatter, splitPathInFrontmatter } from './frontmatterParser.js'
import { findCanonicalGitRoot } from './git.js'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdc'])
const CONFIG_DIRECTORY = 'rule-federation'
const CONFIG_VERSION = 1
const configLocks = new Map<string, Promise<void>>()

type RuleDecisionRecord = {
  decision: RuleImportDecision
  sessionId?: string
  fingerprint: string
  source: RuleSource
  updatedAt: string
}

type RuleFederationConfig = {
  version: 1
  decisions: Record<string, RuleDecisionRecord>
}

type RuleCandidate = {
  originalPath: string
  relativePath: string
  canonicalPath: string
  label: string
  metadata: 'none' | 'cursor' | 'copilot'
}

export type ImportedProjectRule = {
  path: string
  content: string
  globs?: string[]
  source: Exclude<RuleSource, 'claude'>
  provenance: string
  fingerprint: string
}

type DiscoveredRule = NormalizedProjectRule & {
  verifiedPath: string
  content: string
  contentFingerprint: string
  globs?: string[]
}

function normalizeText(content: string): string {
  return content.replace(/\r\n/g, '\n').trim()
}

function fingerprint(content: string): string {
  return createHash('sha256').update(normalizeText(content)).digest('hex')
}

function providerName(source: RuleSource): string {
  switch (source) {
    case 'claude': return 'Claude Code'
    case 'cursor': return 'Cursor'
    case 'windsurf': return 'Windsurf'
    case 'copilot': return 'GitHub Copilot'
  }
}

function logicalRulePath(name: string): string {
  const stem = name
    .replace(/\.(md|mdc)$/i, '')
    .replace(/\.instructions$/i, '')
  return `project/rules/${stem}`
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value).normalize('NFC')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function safeProjectRoot(projectPath: string): Promise<string> {
  return await fs.realpath(projectPath)
}

async function safeRulePath(projectRoot: string, candidate: string): Promise<string | null> {
  if (!path.isAbsolute(candidate)) return null
  try {
    const resolved = await fs.realpath(candidate)
    const root = normalizePath(projectRoot)
    const value = normalizePath(resolved)
    return value === root || value.startsWith(`${root}${path.sep}`) ? resolved : null
  } catch {
    return null
  }
}

function ruleId(source: RuleSource, relativePath: string): string {
  return `${source}:${relativePath.replaceAll('\\', '/').normalize('NFC')}`
}

function decisionKey(rule: Pick<NormalizedProjectRule, 'ruleId'>): string {
  return rule.ruleId
}

async function repositoryIdentity(projectRoot: string): Promise<string> {
  const canonical = findCanonicalGitRoot(projectRoot) ?? projectRoot
  try {
    return normalizePath(await fs.realpath(canonical))
  } catch {
    return normalizePath(canonical)
  }
}

async function configPath(projectRoot: string): Promise<string> {
  const identity = await repositoryIdentity(projectRoot)
  const repositoryHash = createHash('sha256').update(identity).digest('hex')
  return path.join(getClaudeConfigHomeDir(), CONFIG_DIRECTORY, `${repositoryHash}.json`)
}

async function readConfig(projectRoot: string): Promise<RuleFederationConfig> {
  const filePath = await configPath(projectRoot)
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return { version: 1, decisions: {} }
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Partial<RuleFederationConfig>
    if (parsed.version === CONFIG_VERSION && parsed.decisions && typeof parsed.decisions === 'object') {
      return { version: 1, decisions: parsed.decisions }
    }
  } catch {
    // Missing or malformed user-local state is treated as no decisions.
  }
  return { version: 1, decisions: {} }
}

async function withConfigLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = configLocks.get(filePath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const chain = previous.then(() => current)
  configLocks.set(filePath, chain)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (configLocks.get(filePath) === chain) configLocks.delete(filePath)
  }
}

async function writeConfig(projectRoot: string, mutate: (config: RuleFederationConfig) => void): Promise<void> {
  const filePath = await configPath(projectRoot)
  await withConfigLock(filePath, async () => {
    const directory = path.dirname(filePath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const existing = await fs.lstat(filePath).catch(() => null)
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error('Unsafe rule federation state file')
    }
    const config = await readConfig(projectRoot)
    mutate(config)
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      })
      await fs.rename(temporaryPath, filePath)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {})
    }
  })
}

function parsePatterns(value: unknown): string[] | undefined {
  if (typeof value !== 'string' && !Array.isArray(value)) return undefined
  const values = Array.isArray(value) ? value.map(String) : value
  const patterns = splitPathInFrontmatter(values).map(item => item.trim()).filter(Boolean)
  return patterns.length > 0 ? patterns : undefined
}

function parseRuleContent(
  source: RuleSource,
  metadata: RuleCandidate['metadata'],
  rawContent: string,
): { content: string; applicability: NormalizedProjectRule['applicability']; globs?: string[] } {
  const { frontmatter, content } = parseFrontmatter(rawContent)
  if (metadata === 'cursor') {
    const globs = parsePatterns(frontmatter.globs)
    if (frontmatter.alwaysApply === true || frontmatter.alwaysApply === 'true') {
      return { content, applicability: 'always' }
    }
    return globs
      ? { content, applicability: 'conditional', globs }
      : { content, applicability: 'manual' }
  }
  if (metadata === 'copilot') {
    const globs = parsePatterns(frontmatter.applyTo)
    return globs
      ? { content, applicability: 'conditional', globs }
      : { content, applicability: 'manual' }
  }
  const globs = source === 'claude' ? parsePatterns(frontmatter.paths) : undefined
  return globs
    ? { content, applicability: 'conditional', globs }
    : { content, applicability: 'always' }
}

async function fileCandidate(
  projectPath: string,
  relativePath: string,
  canonicalPath: string,
  metadata: RuleCandidate['metadata'] = 'none',
): Promise<RuleCandidate[]> {
  const originalPath = path.join(projectPath, ...relativePath.split('/'))
  try {
    const stat = await fs.lstat(originalPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return []
    return [{ originalPath, relativePath, canonicalPath, label: relativePath, metadata }]
  } catch {
    return []
  }
}

async function directoryCandidates(
  projectPath: string,
  relativeDirectory: string,
  metadata: RuleCandidate['metadata'] = 'none',
): Promise<RuleCandidate[]> {
  const directory = path.join(projectPath, ...relativeDirectory.split('/'))
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && !entry.isSymbolicLink() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({
        originalPath: path.join(directory, entry.name),
        relativePath: `${relativeDirectory}/${entry.name}`,
        canonicalPath: logicalRulePath(entry.name),
        label: `${relativeDirectory}/${entry.name}`,
        metadata,
      }))
  } catch {
    return []
  }
}

function createAdapter(
  source: RuleSource,
  isNative: boolean,
  candidates: (projectPath: string) => Promise<RuleCandidate[]>,
): RuleSourceAdapter {
  return {
    source,
    async discover(projectPath) {
      return (await discoverAdapterRules(source, isNative, candidates, projectPath)).map(({ verifiedPath: _path, content: _content, contentFingerprint: _contentFingerprint, globs: _globs, ...rule }) => rule)
    },
  }
}

async function discoverAdapterRules(
  source: RuleSource,
  isNative: boolean,
  candidates: (projectPath: string) => Promise<RuleCandidate[]>,
  projectPath: string,
): Promise<DiscoveredRule[]> {
  const projectRoot = await safeProjectRoot(projectPath)
  const discovered = await candidates(projectRoot)
  const rules: DiscoveredRule[] = []
  for (const candidate of discovered) {
    const verifiedPath = await safeRulePath(projectRoot, candidate.originalPath)
    if (!verifiedPath) continue
    const pathStat = await fs.lstat(candidate.originalPath)
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) continue
    const before = await fs.stat(verifiedPath)
    const handle = await fs.open(verifiedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    let rawContent: string
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size > 1_000_000 || pathStat.dev !== opened.dev || pathStat.ino !== opened.ino) continue
      const openedPath = await fs.realpath(candidate.originalPath)
      const root = normalizePath(projectRoot)
      const value = normalizePath(openedPath)
      if (value !== root && !value.startsWith(`${root}${path.sep}`)) continue
      rawContent = await handle.readFile('utf-8')
      const after = await handle.stat()
      const current = await fs.stat(verifiedPath)
      if (before.dev !== opened.dev || before.ino !== opened.ino || opened.dev !== after.dev || opened.ino !== after.ino || after.dev !== current.dev || after.ino !== current.ino || opened.size !== after.size || after.size !== current.size || opened.mtimeMs !== after.mtimeMs || after.mtimeMs !== current.mtimeMs) continue
    } finally {
      await handle.close()
    }
    const parsed = parseRuleContent(source, candidate.metadata, rawContent)
    const normalizedContent = normalizeText(parsed.content)
    if (!normalizedContent) continue
    const normalizedGlobs = parsed.globs ? [...parsed.globs].sort() : []
    const effectiveFingerprint = fingerprint(JSON.stringify({
      source,
      ruleId: ruleId(source, candidate.relativePath),
      content: normalizedContent,
      applicability: parsed.applicability,
      globs: normalizedGlobs,
    }))
    rules.push({
      source,
      ruleId: ruleId(source, candidate.relativePath),
      originalPath: candidate.originalPath,
      verifiedPath,
      canonicalPath: candidate.canonicalPath,
      fingerprint: effectiveFingerprint,
      contentFingerprint: fingerprint(normalizedContent),
      content: normalizedContent,
      globs: parsed.globs,
      isNative,
      applicability: parsed.applicability,
      scopes: parsed.globs ?? ['project'],
      tags: [source],
      provenance: { provider: providerName(source), label: candidate.label },
      status: 'active',
      relatedRulePaths: [],
    })
  }
  return rules
}

const claudeCandidates = async (projectPath: string) => [
  ...await fileCandidate(projectPath, 'CLAUDE.md', 'project/global'),
  ...await fileCandidate(projectPath, '.claude/CLAUDE.md', 'project/global'),
  ...await directoryCandidates(projectPath, '.claude/rules'),
  ...await fileCandidate(projectPath, 'CLAUDE.local.md', 'project/local'),
]
const cursorCandidates = async (projectPath: string) => [
  ...await fileCandidate(projectPath, '.cursorrules', 'project/global'),
  ...await directoryCandidates(projectPath, '.cursor/rules', 'cursor'),
]
const windsurfCandidates = async (projectPath: string) => [
  ...await fileCandidate(projectPath, '.windsurfrules', 'project/global'),
  ...await directoryCandidates(projectPath, '.windsurf/rules'),
]
const copilotCandidates = async (projectPath: string) => [
  ...await fileCandidate(projectPath, '.github/copilot-instructions.md', 'project/global'),
  ...await directoryCandidates(projectPath, '.github/instructions', 'copilot'),
]

export const ruleSourceAdapters: readonly RuleSourceAdapter[] = [
  createAdapter('claude', true, claudeCandidates),
  createAdapter('cursor', false, cursorCandidates),
  createAdapter('windsurf', false, windsurfCandidates),
  createAdapter('copilot', false, copilotCandidates),
]

async function discoverRules(projectPath: string, sessionId?: string): Promise<DiscoveredRule[]> {
  const groups = await Promise.all([
    discoverAdapterRules('claude', true, claudeCandidates, projectPath),
    discoverAdapterRules('cursor', false, cursorCandidates, projectPath),
    discoverAdapterRules('windsurf', false, windsurfCandidates, projectPath),
    discoverAdapterRules('copilot', false, copilotCandidates, projectPath),
  ])
  const accepted: DiscoveredRule[] = []
  for (const rule of groups.flat()) {
    if (!rule.isNative) {
      const nativeMatch = accepted.find(candidate => candidate.isNative && (
        candidate.contentFingerprint === rule.contentFingerprint || candidate.canonicalPath === rule.canonicalPath
      ))
      const priorMatch = nativeMatch ?? accepted.find(candidate =>
        candidate.contentFingerprint === rule.contentFingerprint || candidate.canonicalPath === rule.canonicalPath
      )
      if (priorMatch) {
        rule.relatedRulePaths = [priorMatch.originalPath]
        rule.status = priorMatch.contentFingerprint === rule.contentFingerprint
          ? (nativeMatch ? 'overridden-by-native' : 'duplicate')
          : 'conflict'
      }
    }
    accepted.push(rule)
  }
  const config = await readConfig(await safeProjectRoot(projectPath))
  for (const rule of accepted) {
    const record = config.decisions[decisionKey(rule)]
    if (record && record.fingerprint === rule.fingerprint && record.source === rule.source && (
      record.decision !== 'session' || record.sessionId === sessionId
    )) rule.decision = record.decision
  }
  return accepted
}

export async function discoverFederatedProjectRules(projectPath: string, sessionId?: string): Promise<NormalizedProjectRule[]> {
  return (await discoverRules(projectPath, sessionId)).map(({ verifiedPath: _path, content: _content, contentFingerprint: _contentFingerprint, globs: _globs, ...rule }) => rule)
}

function importedContent(rule: DiscoveredRule): string {
  const metadata = JSON.stringify({
    source: rule.source,
    path: rule.provenance.label,
    fingerprint: rule.fingerprint,
    trust: 'user-approved-external-rule',
  })
  return `Imported external IDE rule metadata: ${metadata}\n\n${rule.content}`
}

export async function getImportedProjectRules(projectPath: string, sessionId?: string): Promise<ImportedProjectRule[]> {
  const projectRoot = await safeProjectRoot(projectPath)
  const config = await readConfig(projectRoot)
  const rules = await discoverRules(projectRoot, sessionId)
  const imported: ImportedProjectRule[] = []
  const fingerprints = new Set<string>()
  for (const rule of rules) {
    if (rule.isNative || rule.applicability === 'manual' || rule.status === 'duplicate' || rule.status === 'overridden-by-native') continue
    const record = config.decisions[decisionKey(rule)]
    if (!record || record.fingerprint !== rule.fingerprint || record.source !== rule.source) continue
    if (record.decision !== 'persistent' && !(record.decision === 'session' && record.sessionId === sessionId)) continue
    if (fingerprints.has(rule.contentFingerprint)) continue
    fingerprints.add(rule.contentFingerprint)
    imported.push({
      path: rule.verifiedPath,
      content: importedContent(rule),
      globs: rule.globs,
      source: rule.source as Exclude<RuleSource, 'claude'>,
      provenance: rule.provenance.label,
      fingerprint: rule.fingerprint,
    })
  }
  return imported
}

export async function getImportedProjectRulePaths(projectPath: string, sessionId?: string): Promise<string[]> {
  return (await getImportedProjectRules(projectPath, sessionId)).filter(rule => !rule.globs).map(rule => rule.path)
}

export async function saveRuleImportDecision(input: {
  projectPath: string
  ruleId?: string
  originalPath?: string
  decision: RuleImportDecision
  sessionId?: string
}): Promise<void> {
  const projectRoot = await safeProjectRoot(input.projectPath)
  const rules = await discoverRules(projectRoot, input.sessionId)
  const rule = rules.find(candidate => input.ruleId
    ? candidate.ruleId === input.ruleId
    : input.originalPath !== undefined && normalizePath(candidate.originalPath) === normalizePath(input.originalPath)
  )
  if (!rule || rule.isNative) throw new Error('Rule is not an importable external project rule')
  if (rule.applicability === 'manual' && input.decision !== 'ignore') {
    throw new Error('Manual external rules cannot be automatically imported')
  }
  if (input.decision === 'session' && !input.sessionId) throw new Error('Session decisions require a sessionId')

  await writeConfig(projectRoot, config => {
    config.decisions[decisionKey(rule)] = {
      decision: input.decision,
      ...(input.decision === 'session' ? { sessionId: input.sessionId } : {}),
      fingerprint: rule.fingerprint,
      source: rule.source,
      updatedAt: new Date().toISOString(),
    }
  })
}

export async function getRuleFederationConfigPathForTest(projectPath: string): Promise<string> {
  return configPath(await safeProjectRoot(projectPath))
}
