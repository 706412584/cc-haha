import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { handleProjectRulesApi } from '../api/project-rules.js'
import {
  discoverFederatedProjectRules,
  getImportedProjectRulePaths,
  getRuleFederationConfigPathForTest,
  saveRuleImportDecision,
} from '../../utils/projectRulesFederation.js'
import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'
import { clearMemoryFileCaches, getConditionalRulesForCwdLevelDirectory, getMemoryFiles } from '../../utils/claudemd.js'

const tempProjects: string[] = []

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(project => fs.rm(project, { recursive: true, force: true })))
})

async function createProject(): Promise<string> {
  const project = await fs.mkdtemp(path.join(tmpdir(), 'rule-federation-'))
  tempProjects.push(project)
  execFileSync('git', ['init'], { cwd: project, stdio: 'ignore' })
  await fs.writeFile(path.join(project, '.cursorrules'), 'Use bun.\n')
  return project
}

async function postDecision(project: string, originalPath: string, decision: string): Promise<Response> {
  const rule = (await discoverFederatedProjectRules(project, 'session-desktop-1'))
    .find(candidate => path.resolve(candidate.originalPath) === path.resolve(originalPath))
  if (!rule) throw new Error(`Missing fixture rule: ${originalPath}`)
  await saveRuleImportDecision({
    projectPath: project,
    sessionId: 'session-desktop-1',
    ruleId: rule.ruleId,
    decision: decision as 'session' | 'persistent' | 'ignore',
  })
  return Response.json({ ok: true })
}

describe('project-rules federation decisions', () => {
  test('persists authorization outside the repository and returns it from GET', async () => {
    const project = await createProject()
    const cursorRule = path.join(project, '.cursorrules')

    const response = await postDecision(project, cursorRule, 'persistent')
    expect(response.status).toBe(200)
    const statePath = await getRuleFederationConfigPathForTest(project)
    expect(statePath.startsWith(project)).toBe(false)
    expect(await fs.readFile(statePath, 'utf-8')).toContain('persistent')
    await expect(fs.access(path.join(project, '.cc-haha', 'rule-federation.json'))).rejects.toThrow()

    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(project)}&sessionId=session-desktop-1`)
    const getResponse = await handleProjectRulesApi(
      new Request(url),
      url,
      ['api', 'project-rules'],
    )
    const data = await getResponse.json() as {
      projects: Array<{ isCurrent: boolean; normalizedRules: Array<{ source: string; decision?: string }> }>
    }
    expect(data.projects.find(item => item.isCurrent)?.normalizedRules.find(rule => rule.source === 'cursor')?.decision).toBe('persistent')
  })

  test('loads persistent rules for every session, session rules only for their session, and ignores ignored rules', async () => {
    const project = await createProject()
    const cursorRule = path.join(project, '.cursorrules')

    expect((await postDecision(project, cursorRule, 'persistent')).status).toBe(200)
    expect(await getImportedProjectRulePaths(project, 'another-session')).toEqual([cursorRule])

    expect((await postDecision(project, cursorRule, 'session')).status).toBe(200)
    expect(await getImportedProjectRulePaths(project, 'session-desktop-1')).toEqual([cursorRule])
    expect(await getImportedProjectRulePaths(project, 'another-session')).toEqual([])

    expect((await postDecision(project, cursorRule, 'ignore')).status).toBe(200)
    expect(await getImportedProjectRulePaths(project, 'session-desktop-1')).toEqual([])
  })

  test('keeps decisions independent when providers share one canonical path', async () => {
    const project = await createProject()
    const cursorRule = path.join(project, '.cursorrules')
    const windsurfRule = path.join(project, '.windsurfrules')
    await fs.writeFile(windsurfRule, 'Use npm.\n')

    expect((await postDecision(project, cursorRule, 'persistent')).status).toBe(200)
    expect((await postDecision(project, windsurfRule, 'ignore')).status).toBe(200)
    expect(await getImportedProjectRulePaths(project, 'session-desktop-1')).toEqual([cursorRule])
  })

  test('loads only the deterministic first provider when external rule content is duplicated', async () => {
    const project = await createProject()
    const cursorRule = path.join(project, '.cursorrules')
    const windsurfRule = path.join(project, '.windsurfrules')
    await fs.writeFile(windsurfRule, 'Use bun.\n')

    expect((await postDecision(project, cursorRule, 'persistent')).status).toBe(200)
    expect((await postDecision(project, windsurfRule, 'persistent')).status).toBe(200)
    expect(await getImportedProjectRulePaths(project, 'session-desktop-1')).toEqual([cursorRule])
  })

  test('injects an enabled external rule through the existing Claude memory loader', async () => {
    const project = await createProject()
    const cursorRule = path.join(project, '.cursorrules')
    expect((await postDecision(project, cursorRule, 'persistent')).status).toBe(200)

    const previousCwd = getOriginalCwd()
    try {
      setOriginalCwd(project)
      clearMemoryFileCaches()
      const files = await getMemoryFiles()
      expect(files.find(file => file.path === cursorRule)?.content).toContain('Use bun.')
    } finally {
      setOriginalCwd(previousCwd)
      clearMemoryFileCaches()
    }
  })

  test('loads Cursor .mdc rules through the existing Claude memory parser', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    const cursorRule = path.join(cursorDirectory, 'typescript.mdc')
    await fs.mkdir(cursorDirectory, { recursive: true })
    await fs.writeFile(cursorRule, '---\nalwaysApply: true\n---\nUse strict TypeScript.\n')
    expect((await postDecision(project, cursorRule, 'persistent')).status).toBe(200)

    const previousCwd = getOriginalCwd()
    try {
      setOriginalCwd(project)
      clearMemoryFileCaches()
      const files = await getMemoryFiles()
      expect(files.find(file => file.path === cursorRule)?.content).toContain('Use strict TypeScript.')
    } finally {
      setOriginalCwd(previousCwd)
      clearMemoryFileCaches()
    }
  })

  test('loads federated rules before native Claude rules so native rules keep higher priority', async () => {
    const project = await createProject()
    const cursorRule = path.join(project, '.cursorrules')
    const nativeRule = path.join(project, 'CLAUDE.md')
    await fs.writeFile(nativeRule, 'Native instructions.\n')
    expect((await postDecision(project, cursorRule, 'persistent')).status).toBe(200)

    const previousCwd = getOriginalCwd()
    try {
      setOriginalCwd(project)
      clearMemoryFileCaches()
      const files = await getMemoryFiles()
      const importedIndex = files.findIndex(file => file.path === cursorRule)
      const nativeIndex = files.findIndex(file => file.path === nativeRule)
      expect(importedIndex).toBeGreaterThanOrEqual(0)
      expect(nativeIndex).toBeGreaterThan(importedIndex)
    } finally {
      setOriginalCwd(previousCwd)
      clearMemoryFileCaches()
    }
  })

  test('shares user-local authorization across worktrees while loading the active checkout', async () => {
    const mainProject = await createProject()
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '.cursorrules'], {
      cwd: mainProject,
      stdio: 'ignore',
    })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'], {
      cwd: mainProject,
      stdio: 'ignore',
    })
    const worktree = await fs.mkdtemp(path.join(tmpdir(), 'rule-federation-worktree-'))
    await fs.rm(worktree, { recursive: true })
    tempProjects.push(worktree)
    execFileSync('git', ['worktree', 'add', '-b', `fixture-${Date.now()}`, worktree], {
      cwd: mainProject,
      stdio: 'ignore',
    })
    const cursorRule = path.join(worktree, '.cursorrules')

    expect((await postDecision(worktree, cursorRule, 'persistent')).status).toBe(200)
    expect(await getRuleFederationConfigPathForTest(worktree)).toBe(await getRuleFederationConfigPathForTest(mainProject))
    expect(await getImportedProjectRulePaths(worktree, 'session-desktop-1')).toEqual([cursorRule])
  })

  test('rejects traversal, paths outside the project, and symlink escapes without writing config', async () => {
    const project = await createProject()
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'rule-federation-outside-'))
    tempProjects.push(outside)
    const outsideRule = path.join(outside, 'outside.md')
    await fs.writeFile(outsideRule, 'outside')
    const linkDirectory = path.join(project, 'linked')
    await fs.symlink(outside, linkDirectory, 'junction')
    const linkedRule = path.join(linkDirectory, 'outside.md')

    for (const candidate of ['../outside.md', outsideRule, linkedRule]) {
      await expect(saveRuleImportDecision({
        projectPath: project,
        originalPath: candidate,
        decision: 'session',
        sessionId: 'session-desktop-1',
      })).rejects.toThrow()
    }
    await expect(fs.access(path.join(project, '.cc-haha', 'rule-federation.json'))).rejects.toThrow()
  })

  test('keeps same-provider rules independent by stable relative-path identity', async () => {
    const project = await createProject()
    const rulesDirectory = path.join(project, '.cursor', 'rules')
    await fs.mkdir(rulesDirectory, { recursive: true })
    const markdownRule = path.join(rulesDirectory, 'testing.md')
    const mdcRule = path.join(rulesDirectory, 'testing.mdc')
    await fs.writeFile(markdownRule, 'Markdown rule.\n')
    await fs.writeFile(mdcRule, '---\nalwaysApply: true\n---\nMDC rule.\n')
    const rules = await discoverFederatedProjectRules(project, 'session-desktop-1')
    const cursorRules = rules.filter(rule => rule.source === 'cursor' && rule.provenance.label.includes('testing.'))
    expect(new Set(cursorRules.map(rule => rule.ruleId)).size).toBe(2)
  })

  test('preserves conditional Cursor and Copilot applicability without globally importing manual rules', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    const copilotDirectory = path.join(project, '.github', 'instructions')
    await fs.mkdir(cursorDirectory, { recursive: true })
    await fs.mkdir(copilotDirectory, { recursive: true })
    const cursorRule = path.join(cursorDirectory, 'typescript.mdc')
    const copilotRule = path.join(copilotDirectory, 'tests.instructions.md')
    await fs.writeFile(cursorRule, '---\nglobs: "src/**/*.ts"\nalwaysApply: false\n---\nUse strict types.\n')
    await fs.writeFile(copilotRule, '---\napplyTo: "**/*.test.ts"\n---\nUse Bun tests.\n')
    const rules = await discoverFederatedProjectRules(project, 'session-desktop-1')
    expect(rules.find(rule => rule.originalPath === cursorRule)).toMatchObject({ applicability: 'conditional', scopes: ['src/**/*.ts'] })
    expect(rules.find(rule => rule.originalPath === copilotRule)).toMatchObject({ applicability: 'conditional', scopes: ['**/*.test.ts'] })
    const manualDirectory = path.join(project, '.cursor', 'rules')
    const manualPath = path.join(manualDirectory, 'manual.mdc')
    await fs.writeFile(manualPath, 'Run this only when explicitly requested.\n')
    const manual = (await discoverFederatedProjectRules(project, 'session-desktop-1')).find(rule => rule.originalPath === manualPath)!
    await expect(saveRuleImportDecision({ projectPath: project, ruleId: manual.ruleId, decision: 'persistent' })).rejects.toThrow('Manual external rules')
  })

  test('invalidates authorization when applicability expands without changing content', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    await fs.mkdir(cursorDirectory, { recursive: true })
    const cursorRule = path.join(cursorDirectory, 'scoped.mdc')
    await fs.writeFile(cursorRule, '---\nglobs: "src/**/*.ts"\nalwaysApply: false\n---\nKeep this content.\n')
    const before = (await discoverFederatedProjectRules(project)).find(rule => rule.originalPath === cursorRule)!
    await saveRuleImportDecision({ projectPath: project, ruleId: before.ruleId, decision: 'persistent' })
    expect((await getImportedProjectRulePaths(project)).includes(cursorRule)).toBe(false)

    await fs.writeFile(cursorRule, '---\nalwaysApply: true\n---\nKeep this content.\n')
    const after = (await discoverFederatedProjectRules(project)).find(rule => rule.originalPath === cursorRule)!
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.decision).toBeUndefined()
    expect(await getImportedProjectRulePaths(project)).not.toContain(cursorRule)
  })

  test('invalidates authorization when ordered negation glob semantics change', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    await fs.mkdir(cursorDirectory, { recursive: true })
    const cursorRule = path.join(cursorDirectory, 'ordered.mdc')
    await fs.writeFile(cursorRule, '---\nglobs:\n  - "**/*.ts"\n  - "!src/**"\nalwaysApply: false\n---\nKeep ordered globs.\n')
    const before = (await discoverFederatedProjectRules(project)).find(rule => rule.originalPath === cursorRule)!
    await saveRuleImportDecision({ projectPath: project, ruleId: before.ruleId, decision: 'persistent' })

    await fs.writeFile(cursorRule, '---\nglobs:\n  - "!src/**"\n  - "**/*.ts"\nalwaysApply: false\n---\nKeep ordered globs.\n')
    const after = (await discoverFederatedProjectRules(project)).find(rule => rule.originalPath === cursorRule)!
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.decision).toBeUndefined()

    const previousCwd = getOriginalCwd()
    try {
      setOriginalCwd(project)
      const files = await getConditionalRulesForCwdLevelDirectory(project, path.join(project, 'src', 'a.ts'), new Set())
      expect(files.some(file => file.path === cursorRule)).toBe(false)
    } finally {
      setOriginalCwd(previousCwd)
      clearMemoryFileCaches()
    }
  })

  test('bounds untrusted rule candidates per directory and across providers', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    const windsurfDirectory = path.join(project, '.windsurf', 'rules')
    await fs.mkdir(cursorDirectory, { recursive: true })
    await fs.mkdir(windsurfDirectory, { recursive: true })
    await Promise.all(Array.from({ length: 140 }, async (_, index) => {
      const name = `${String(index).padStart(3, '0')}.md`
      await Promise.all([
        fs.writeFile(path.join(cursorDirectory, name), `Cursor ${index}.\n`),
        fs.writeFile(path.join(windsurfDirectory, name), `Windsurf ${index}.\n`),
      ])
    }))

    const rules = await discoverFederatedProjectRules(project)
    expect(rules.filter(rule => rule.provenance.label.startsWith('.cursor/rules/'))).toHaveLength(128)
    expect(rules).toHaveLength(256)
  })

  test('bounds cumulative bytes read from untrusted rules', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    await fs.mkdir(cursorDirectory, { recursive: true })
    const content = 'x'.repeat(900 * 1024)
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      fs.writeFile(path.join(cursorDirectory, `${index}.md`), content),
    ))

    const rules = await discoverFederatedProjectRules(project)
    expect(rules.filter(rule => rule.provenance.label.startsWith('.cursor/rules/'))).toHaveLength(9)
  })

  test('applies approved conditional rules only to matching files through the real loader', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    await fs.mkdir(cursorDirectory, { recursive: true })
    const cursorRule = path.join(cursorDirectory, 'conditional.mdc')
    await fs.writeFile(cursorRule, '---\nglobs: "src/**/*.{ts,tsx}"\nalwaysApply: false\n---\nUse strict types.\n')
    const rule = (await discoverFederatedProjectRules(project)).find(candidate => candidate.originalPath === cursorRule)!
    await saveRuleImportDecision({ projectPath: project, ruleId: rule.ruleId, decision: 'persistent' })
    const previousCwd = getOriginalCwd()
    try {
      setOriginalCwd(project)
      const ts = await getConditionalRulesForCwdLevelDirectory(project, path.join(project, 'src', 'a.ts'), new Set())
      const tsx = await getConditionalRulesForCwdLevelDirectory(project, path.join(project, 'src', 'a.tsx'), new Set())
      const js = await getConditionalRulesForCwdLevelDirectory(project, path.join(project, 'src', 'a.js'), new Set())
      expect(ts.some(file => file.path === cursorRule)).toBe(true)
      expect(tsx.some(file => file.path === cursorRule)).toBe(true)
      expect(js.some(file => file.path === cursorRule)).toBe(false)
    } finally {
      setOriginalCwd(previousCwd)
      clearMemoryFileCaches()
    }
  })

  test('bounds hostile brace expansion before authorization', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    await fs.mkdir(cursorDirectory, { recursive: true })
    const cursorRule = path.join(cursorDirectory, 'hostile.mdc')
    const hostile = Array.from({ length: 30 }, () => '{a,b}').join('')
    await fs.writeFile(cursorRule, `---\nglobs: "${hostile}"\nalwaysApply: false\n---\nDo not expand me.\n`)
    const rule = (await discoverFederatedProjectRules(project)).find(candidate => candidate.originalPath === cursorRule)!
    expect(rule.applicability).toBe('manual')
    await expect(saveRuleImportDecision({ projectPath: project, ruleId: rule.ruleId, decision: 'persistent' })).rejects.toThrow('Manual external rules')
  })

  test('expands brace globs for conditional provider rules', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    await fs.mkdir(cursorDirectory, { recursive: true })
    const cursorRule = path.join(cursorDirectory, 'brace.mdc')
    await fs.writeFile(cursorRule, '---\nglobs: "src/**/*.{ts,tsx}"\nalwaysApply: false\n---\nUse strict types.\n')
    const rule = (await discoverFederatedProjectRules(project)).find(candidate => candidate.originalPath === cursorRule)!
    expect(rule.scopes).toEqual(['src/**/*.ts', 'src/**/*.tsx'])
  })

  test('serializes concurrent decisions without losing either update', async () => {
    const project = await createProject()
    const windsurfRule = path.join(project, '.windsurfrules')
    await fs.writeFile(windsurfRule, 'Use npm.\n')
    const rules = await discoverFederatedProjectRules(project, 'session-desktop-1')
    const cursor = rules.find(rule => rule.source === 'cursor')!
    const windsurf = rules.find(rule => rule.source === 'windsurf')!
    await Promise.all([
      saveRuleImportDecision({ projectPath: project, ruleId: cursor.ruleId, decision: 'persistent' }),
      saveRuleImportDecision({ projectPath: project, ruleId: windsurf.ruleId, decision: 'ignore' }),
    ])
    const state = await fs.readFile(await getRuleFederationConfigPathForTest(project), 'utf-8')
    expect(state).toContain(cursor.ruleId)
    expect(state).toContain(windsurf.ruleId)
  })
})
