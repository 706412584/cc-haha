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

  test('discovers AGENTS.md, Devin, and Zcode rules with provider, path, and applicability metadata', async () => {
    const project = await createProject()
    const fixtures = [
      ['AGENTS.md', 'Shared agent instructions.\n'],
      ['.devin/rules.md', 'Devin root rules.\n'],
      ['.devin/rules/devin-cli.md', 'Devin CLI rules.\n'],
      ['.zcode/rules.md', 'Zcode root rules.\n'],
      ['.zcode/rules/zcode-cli.md', 'Zcode CLI rules.\n'],
    ] as const

    for (const [relativePath, content] of fixtures) {
      const filePath = path.join(project, ...relativePath.split('/'))
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content)
    }

    const rules = await discoverFederatedProjectRules(project, 'session-desktop-1')
    expect(rules.find(rule => rule.originalPath === path.join(project, 'AGENTS.md'))).toMatchObject({
      source: 'agents-md',
      originalPath: path.join(project, 'AGENTS.md'),
      provenance: { provider: 'AGENTS.md', label: 'AGENTS.md' },
      applicability: 'always',
    })
    expect(rules.find(rule => rule.originalPath === path.join(project, '.devin', 'rules.md'))).toMatchObject({
      source: 'devin',
      originalPath: path.join(project, '.devin', 'rules.md'),
      provenance: { provider: 'Devin', label: '.devin/rules.md' },
      applicability: 'always',
    })
    expect(rules.find(rule => rule.originalPath === path.join(project, '.devin', 'rules', 'devin-cli.md'))).toMatchObject({
      source: 'devin',
      originalPath: path.join(project, '.devin', 'rules', 'devin-cli.md'),
      provenance: { provider: 'Devin', label: '.devin/rules/devin-cli.md' },
      applicability: 'always',
    })
    expect(rules.find(rule => rule.originalPath === path.join(project, '.zcode', 'rules.md'))).toMatchObject({
      source: 'zcode',
      originalPath: path.join(project, '.zcode', 'rules.md'),
      provenance: { provider: 'Zcode', label: '.zcode/rules.md' },
      applicability: 'always',
    })
    expect(rules.find(rule => rule.originalPath === path.join(project, '.zcode', 'rules', 'zcode-cli.md'))).toMatchObject({
      source: 'zcode',
      originalPath: path.join(project, '.zcode', 'rules', 'zcode-cli.md'),
      provenance: { provider: 'Zcode', label: '.zcode/rules/zcode-cli.md' },
      applicability: 'always',
    })
  })

  test('injects a persistent Devin rule through the real memory loader', async () => {
    const project = await createProject()
    const devinRule = path.join(project, '.devin', 'rules', 'devin-cli.md')
    await fs.mkdir(path.dirname(devinRule), { recursive: true })
    await fs.writeFile(devinRule, 'Use Devin rules from memory.\n')
    expect((await postDecision(project, devinRule, 'persistent')).status).toBe(200)

    const previousCwd = getOriginalCwd()
    try {
      setOriginalCwd(project)
      clearMemoryFileCaches()
      const files = await getMemoryFiles()
      expect(files.find(file => file.path === devinRule)?.content).toContain('Use Devin rules from memory.')
    } finally {
      setOriginalCwd(previousCwd)
      clearMemoryFileCaches()
    }
  })

  test('deduplicates AGENTS.md against native CLAUDE.md before memory injection', async () => {
    const project = await createProject()
    const claudeRule = path.join(project, 'CLAUDE.md')
    const agentsRule = path.join(project, 'AGENTS.md')
    const sharedContent = 'Shared agent instructions.\n'
    await fs.writeFile(claudeRule, sharedContent)
    await fs.writeFile(agentsRule, sharedContent)
    expect((await postDecision(project, agentsRule, 'persistent')).status).toBe(200)

    const discovered = await discoverFederatedProjectRules(project, 'session-desktop-1')
    expect(discovered.find(rule => rule.originalPath === agentsRule)).toMatchObject({
      source: 'agents-md',
      originalPath: agentsRule,
      applicability: 'always',
      status: 'overridden-by-native',
      decision: 'persistent',
      provenance: { provider: 'AGENTS.md', label: 'AGENTS.md' },
    })

    const previousCwd = getOriginalCwd()
    try {
      setOriginalCwd(project)
      clearMemoryFileCaches()
      const files = await getMemoryFiles()
      expect(files.filter(file => file.path === claudeRule)).toHaveLength(1)
      expect(files.some(file => file.path === agentsRule)).toBe(false)
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

  test('discovers Kiro, Trae, Qoder, and CodeBuddy with their native applicability metadata', async () => {
    const project = await createProject()
    const fixtures = [
      ['.kiro/steering/typescript.md', '---\ninclusion: fileMatch\nfileMatchPattern: "src/**/*.ts"\n---\nKiro TypeScript.\n'],
      ['.trae/rules/project.md', 'Trae project rule.\n'],
      ['.qoder/rules/always.md', '---\ntrigger: always_on\nalwaysApply: true\n---\nQoder always.\n'],
      ['.qoder/rules/manual.md', '---\ntrigger: model_decision\n---\nQoder manual.\n'],
      ['.codebuddy/rules/typescript.mdc', '---\nglobs: "src/**/*.ts"\nalwaysApply: false\n---\nCodeBuddy TypeScript.\n'],
      ['.codebuddy/rules/always.md', '---\ntype: always\n---\nCodeBuddy always.\n'],
    ] as const
    for (const [relativePath, content] of fixtures) {
      const filePath = path.join(project, ...relativePath.split('/'))
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content)
    }

    const rules = await discoverFederatedProjectRules(project, 'session-desktop-1')
    expect(rules.find(rule => rule.provenance.label === '.kiro/steering/typescript.md')).toMatchObject({
      source: 'kiro', applicability: 'conditional', scopes: ['src/**/*.ts'],
    })
    expect(rules.find(rule => rule.provenance.label === '.trae/rules/project.md')).toMatchObject({
      source: 'trae', applicability: 'always',
    })
    expect(rules.find(rule => rule.provenance.label === '.qoder/rules/always.md')).toMatchObject({
      source: 'qoder', applicability: 'always',
    })
    expect(rules.find(rule => rule.provenance.label === '.qoder/rules/manual.md')).toMatchObject({
      source: 'qoder', applicability: 'manual',
    })
    expect(rules.find(rule => rule.provenance.label === '.codebuddy/rules/typescript.mdc')).toMatchObject({
      source: 'codebuddy', applicability: 'conditional', scopes: ['src/**/*.ts'],
    })
    expect(rules.find(rule => rule.provenance.label === '.codebuddy/rules/always.md')).toMatchObject({
      source: 'codebuddy', applicability: 'always',
    })
  })

  test('loads approved Kiro and CodeBuddy conditional rules through the real loader', async () => {
    const project = await createProject()
    const fixtures = [
      ['.kiro/steering/typescript.md', '---\ninclusion: fileMatch\nfileMatchPattern: "src/**/*.ts"\n---\nKiro TypeScript.\n'],
      ['.codebuddy/rules/typescript.mdc', '---\nglobs: "src/**/*.ts"\nalwaysApply: false\n---\nCodeBuddy TypeScript.\n'],
    ] as const
    const paths: string[] = []
    for (const [relativePath, content] of fixtures) {
      const filePath = path.join(project, ...relativePath.split('/'))
      paths.push(filePath)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content)
      const rule = (await discoverFederatedProjectRules(project)).find(candidate => candidate.originalPath === filePath)!
      await saveRuleImportDecision({ projectPath: project, ruleId: rule.ruleId, decision: 'persistent' })
    }

    const previousCwd = getOriginalCwd()
    try {
      setOriginalCwd(project)
      clearMemoryFileCaches()
      const tsRules = await getConditionalRulesForCwdLevelDirectory(project, path.join(project, 'src', 'file.ts'), new Set())
      const jsRules = await getConditionalRulesForCwdLevelDirectory(project, path.join(project, 'src', 'file.js'), new Set())
      expect(paths.every(filePath => tsRules.some(rule => rule.path === filePath))).toBe(true)
      expect(paths.every(filePath => !jsRules.some(rule => rule.path === filePath))).toBe(true)
    } finally {
      setOriginalCwd(previousCwd)
      clearMemoryFileCaches()
    }
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

  test('bounds untrusted rule candidates without starving later providers', async () => {
    const project = await createProject()
    const cursorDirectory = path.join(project, '.cursor', 'rules')
    const windsurfDirectory = path.join(project, '.windsurf', 'rules')
    const kiroDirectory = path.join(project, '.kiro', 'steering')
    const codebuddyDirectory = path.join(project, '.codebuddy', 'rules')
    await Promise.all([
      fs.mkdir(cursorDirectory, { recursive: true }),
      fs.mkdir(windsurfDirectory, { recursive: true }),
      fs.mkdir(kiroDirectory, { recursive: true }),
      fs.mkdir(codebuddyDirectory, { recursive: true }),
    ])
    await Promise.all([
      ...Array.from({ length: 140 }, async (_, index) => {
        const name = `${String(index).padStart(3, '0')}.md`
        await Promise.all([
          fs.writeFile(path.join(cursorDirectory, name), `Cursor ${index}.\n`),
          fs.writeFile(path.join(windsurfDirectory, name), `Windsurf ${index}.\n`),
        ])
      }),
      fs.writeFile(path.join(kiroDirectory, 'late.md'), 'Kiro late provider.\n'),
      fs.writeFile(path.join(codebuddyDirectory, 'late.md'), '---\ntype: always\n---\nCodeBuddy late provider.\n'),
    ])

    const rules = await discoverFederatedProjectRules(project)
    expect(rules.filter(rule => rule.source === 'cursor').length).toBeLessThanOrEqual(64)
    expect(rules.filter(rule => rule.source === 'windsurf').length).toBeLessThanOrEqual(64)
    expect(rules.some(rule => rule.source === 'kiro')).toBe(true)
    expect(rules.some(rule => rule.source === 'codebuddy')).toBe(true)
    expect(rules.length).toBeLessThanOrEqual(256)
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
