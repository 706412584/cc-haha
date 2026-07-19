import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  NormalizedProjectRule,
  RuleImportDecision,
  RuleSource,
  RuleSourceAdapter,
} from '../types/projectRules.js'
import { resolveGitDir, getCommonDir } from './git/gitFilesystem.js'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdc'])
const CONFIG_DIRECTORY = '.cc-haha'
const CONFIG_FILENAME = 'rule-federation.json'

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
  canonicalPath: string
  label: string
  scopes?: string[]
  tags?: string[]
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex')
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

async function safeProjectRoot(projectPath: string): Promise<string> {
  try {
    return await fs.realpath(projectPath)
  } catch {
    return path.resolve(projectPath)
  }
}

async function safeRulePath(projectRoot: string, candidate: string): Promise<string | null> {
  if (!path.isAbsolute(candidate)) return null
  let resolved: string
  try {
    resolved = await fs.realpath(candidate)
  } catch {
    return null
  }
  const boundary = projectRoot.endsWith(path.sep) ? projectRoot : `${projectRoot}${path.sep}`
  return resolved.startsWith(boundary) ? resolved : null
}

function decisionKey(rule: Pick<NormalizedProjectRule, 'source' | 'canonicalPath'>): string {
  return `${rule.source}:${rule.canonicalPath}`
}

function configPath(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_DIRECTORY, CONFIG_FILENAME)
}

async function readConfig(projectRoot: string): Promise<RuleFederationConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath(projectRoot), 'utf-8')) as RuleFederationConfig
    if (parsed.version === 1 && parsed.decisions && typeof parsed.decisions === 'object') {
      return parsed
    }
  } catch {
    // Missing or malformed local config is treated as no decisions.
  }
  return { version: 1, decisions: {} }
}

async function ensureConfigIsGitignored(projectRoot: string): Promise<void> {
  const resolvedGitDirectory = await resolveGitDir(projectRoot)
  if (!resolvedGitDirectory) return
  const gitDirectory = (await getCommonDir(resolvedGitDirectory)) ?? resolvedGitDirectory
  const infoDirectory = path.join(gitDirectory, 'info')
  const excludePath = path.join(infoDirectory, 'exclude')
  let existing = ''
  try {
    existing = await fs.readFile(excludePath, 'utf-8')
  } catch {
    // A newly initialized repository may not have an exclude file yet.
  }
  if (existing.split(/\r?\n/).includes(`/${CONFIG_DIRECTORY}/`)) return
  await fs.mkdir(infoDirectory, { recursive: true })
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  await fs.writeFile(excludePath, `${existing}${separator}/${CONFIG_DIRECTORY}/\n`, 'utf-8')
}

async function fileCandidate(
  projectPath: string,
  relativePath: string,
  canonicalPath: string,
): Promise<RuleCandidate[]> {
  const originalPath = path.join(projectPath, ...relativePath.split('/'))
  try {
    await fs.access(originalPath)
    return [{ originalPath, canonicalPath, label: relativePath }]
  } catch {
    return []
  }
}

async function directoryCandidates(
  projectPath: string,
  relativeDirectory: string,
): Promise<RuleCandidate[]> {
  const directory = path.join(projectPath, ...relativeDirectory.split('/'))
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({
        originalPath: path.join(directory, entry.name),
        canonicalPath: logicalRulePath(entry.name),
        label: `${relativeDirectory}/${entry.name}`,
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
      const projectRoot = await safeProjectRoot(projectPath)
      const discovered = await candidates(projectPath)
      const rules: NormalizedProjectRule[] = []
      for (const candidate of discovered) {
        const safePath = await safeRulePath(projectRoot, candidate.originalPath)
        if (!safePath) continue
        const content = await fs.readFile(safePath, 'utf-8')
        rules.push({
          source,
          originalPath: candidate.originalPath,
          canonicalPath: candidate.canonicalPath,
          fingerprint: fingerprint(content),
          isNative,
          scopes: candidate.scopes ?? ['project'],
          tags: candidate.tags ?? [source],
          provenance: {
            provider: providerName(source),
            label: candidate.label,
          },
          status: 'active',
          relatedRulePaths: [],
        })
      }
      return rules
    },
  }
}

const claudeAdapter = createAdapter('claude', true, async projectPath => [
  ...await fileCandidate(projectPath, 'CLAUDE.md', 'project/global'),
  ...await fileCandidate(projectPath, '.claude/CLAUDE.md', 'project/global'),
  ...await directoryCandidates(projectPath, '.claude/rules'),
  ...await fileCandidate(projectPath, 'CLAUDE.local.md', 'project/local'),
])

const cursorAdapter = createAdapter('cursor', false, async projectPath => [
  ...await fileCandidate(projectPath, '.cursorrules', 'project/global'),
  ...await directoryCandidates(projectPath, '.cursor/rules'),
])

const windsurfAdapter = createAdapter('windsurf', false, async projectPath => [
  ...await fileCandidate(projectPath, '.windsurfrules', 'project/global'),
  ...await directoryCandidates(projectPath, '.windsurf/rules'),
])

const copilotAdapter = createAdapter('copilot', false, async projectPath => [
  ...await fileCandidate(projectPath, '.github/copilot-instructions.md', 'project/global'),
  ...await directoryCandidates(projectPath, '.github/instructions'),
])

export const ruleSourceAdapters: readonly RuleSourceAdapter[] = [
  claudeAdapter,
  cursorAdapter,
  windsurfAdapter,
  copilotAdapter,
]

export async function discoverFederatedProjectRules(
  projectPath: string,
  sessionId?: string,
): Promise<NormalizedProjectRule[]> {
  const discovered = (await Promise.all(
    ruleSourceAdapters.map(adapter => adapter.discover(projectPath)),
  )).flat()
  const accepted: NormalizedProjectRule[] = []

  for (const rule of discovered) {
    if (rule.isNative) {
      accepted.push(rule)
      continue
    }
    const nativeMatch = accepted.find(candidate =>
      candidate.isNative && (
        candidate.fingerprint === rule.fingerprint ||
        candidate.canonicalPath === rule.canonicalPath
      ),
    )
    const priorMatch = nativeMatch ?? accepted.find(candidate =>
      candidate.fingerprint === rule.fingerprint ||
      candidate.canonicalPath === rule.canonicalPath,
    )
    if (priorMatch) {
      rule.relatedRulePaths = [priorMatch.originalPath]
      if (nativeMatch) {
        rule.status = nativeMatch.fingerprint === rule.fingerprint
          ? 'overridden-by-native'
          : 'conflict'
      } else {
        rule.status = priorMatch.fingerprint === rule.fingerprint
          ? 'duplicate'
          : 'conflict'
      }
    }
    accepted.push(rule)
  }

  const projectRoot = await safeProjectRoot(projectPath)
  const config = await readConfig(projectRoot)
  for (const rule of accepted) {
    const record = config.decisions[decisionKey(rule)]
    if (
      record &&
      record.fingerprint === rule.fingerprint &&
      record.source === rule.source &&
      (record.decision !== 'session' || record.sessionId === sessionId)
    ) {
      rule.decision = record.decision
    }
  }

  return accepted
}

export async function getImportedProjectRulePaths(
  projectPath: string,
  sessionId?: string,
): Promise<string[]> {
  const projectRoot = await safeProjectRoot(projectPath)
  const config = await readConfig(projectRoot)
  const rules = await discoverFederatedProjectRules(projectRoot, sessionId)
  const imported: string[] = []
  for (const rule of rules) {
    if (
      rule.isNative ||
      rule.status === 'duplicate' ||
      rule.status === 'overridden-by-native'
    ) continue
    const record = config.decisions[decisionKey(rule)]
    if (!record || record.fingerprint !== rule.fingerprint || record.source !== rule.source) continue
    if (record.decision === 'persistent' || (
      record.decision === 'session' && record.sessionId === sessionId
    )) {
      imported.push(rule.originalPath)
    }
  }
  return imported
}

export async function saveRuleImportDecision(input: {
  projectPath: string
  originalPath: string
  decision: RuleImportDecision
  sessionId?: string
}): Promise<void> {
  const projectRoot = await safeProjectRoot(input.projectPath)
  const safeOriginalPath = await safeRulePath(projectRoot, input.originalPath)
  if (!safeOriginalPath) throw new Error('Rule path escapes project directory')

  const rules = await discoverFederatedProjectRules(projectRoot, input.sessionId)
  const rule = rules.find(candidate => {
    const expected = path.resolve(candidate.originalPath)
    return expected === path.resolve(input.originalPath)
  })
  if (!rule || rule.isNative) throw new Error('Rule is not an importable external project rule')
  if (input.decision === 'session' && !input.sessionId) {
    throw new Error('Session decisions require a sessionId')
  }

  const config = await readConfig(projectRoot)
  config.decisions[decisionKey(rule)] = {
    decision: input.decision,
    ...(input.decision === 'session' ? { sessionId: input.sessionId } : {}),
    fingerprint: rule.fingerprint,
    source: rule.source,
    updatedAt: new Date().toISOString(),
  }
  const directory = path.dirname(configPath(projectRoot))
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const resolvedDirectory = await fs.realpath(directory)
  if (resolvedDirectory !== directory && resolvedDirectory !== path.resolve(directory)) {
    throw new Error('Rule config directory escapes project directory')
  }
  await fs.writeFile(configPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  })
  await ensureConfigIsGitignored(projectRoot)
}
