import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  getAddDirSkillRoots,
  getNestedSkillDirCandidates,
  getProjectSkillRoots,
  getUserAgentSkillsDir,
  getUserSkillRoots,
  isAgentSkillsDirectoryEnabled,
  outranksClaimedSkill,
} from '../skillRoots.js'

let tmpHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalClaudeConfigDir: string | undefined
let originalDisableEnv: string | undefined

async function mkdirp(...segments: string[]): Promise<string> {
  const dir = path.join(...segments)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function writeSettings(value: Record<string, unknown>): Promise<void> {
  const configDir = path.join(tmpHome, '.claude')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(
    path.join(configDir, 'settings.json'),
    JSON.stringify(value),
    'utf-8',
  )
  resetSettingsCache()
}

describe('skillRoots', () => {
  beforeEach(async () => {
    tmpHome = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'skill-roots-test-')),
    )
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalDisableEnv = process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR

    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
    delete process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR
    resetSettingsCache()
  })

  afterEach(async () => {
    for (const [key, value] of [
      ['HOME', originalHome],
      ['USERPROFILE', originalUserProfile],
      ['CLAUDE_CONFIG_DIR', originalClaudeConfigDir],
      ['CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR', originalDisableEnv],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetSettingsCache()
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  describe('user roots', () => {
    it('lists .claude before .agents so .claude wins name collisions', () => {
      const roots = getUserSkillRoots()

      expect(roots.map(r => r.flavor)).toEqual(['claude', 'agents'])
      expect(roots[0]!.path).toBe(path.join(tmpHome, '.claude', 'skills'))
      expect(roots[1]!.path).toBe(path.join(tmpHome, '.agents', 'skills'))
    })

    it('puts both user roots in one scope so same-named skills collide', () => {
      const roots = getUserSkillRoots()

      expect(new Set(roots.map(r => r.scopeKey)).size).toBe(1)
    })

    it('anchors the .agents root at $HOME even when CLAUDE_CONFIG_DIR is elsewhere', () => {
      // .agents is a shared cross-tool space; following our own config dir
      // would put us out of step with Codex/Cursor/Gemini reading $HOME.
      process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, 'custom-config')

      const roots = getUserSkillRoots()

      expect(roots[0]!.path).toBe(path.join(tmpHome, 'custom-config', 'skills'))
      expect(roots[1]!.path).toBe(path.join(tmpHome, '.agents', 'skills'))
      expect(getUserAgentSkillsDir()).toBe(path.join(tmpHome, '.agents', 'skills'))
    })
  })

  describe('opt-out', () => {
    it('drops .agents roots when the env var is set', () => {
      process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR = '1'

      expect(isAgentSkillsDirectoryEnabled()).toBe(false)
      expect(getUserSkillRoots().map(r => r.flavor)).toEqual(['claude'])
      expect(getAddDirSkillRoots('/tmp/added').map(r => r.flavor)).toEqual(['claude'])
      expect(getNestedSkillDirCandidates('/tmp/pkg')).toEqual([
        path.join('/tmp/pkg', '.claude', 'skills'),
      ])
    })

    it('drops .agents roots when disabled in settings.json', async () => {
      await writeSettings({ disableAgentSkillsDirectory: true })

      expect(isAgentSkillsDirectoryEnabled()).toBe(false)
      expect(getUserSkillRoots().map(r => r.flavor)).toEqual(['claude'])
    })

    it('stays enabled when settings.json says nothing about it', async () => {
      await writeSettings({})

      expect(isAgentSkillsDirectoryEnabled()).toBe(true)
      expect(getUserSkillRoots().map(r => r.flavor)).toEqual(['claude', 'agents'])
    })

    it('never suppresses .claude roots', async () => {
      await writeSettings({ disableAgentSkillsDirectory: true })

      expect(getUserSkillRoots()[0]!.path).toBe(
        path.join(tmpHome, '.claude', 'skills'),
      )
    })
  })

  describe('project roots', () => {
    it('returns both conventions per level, .claude first, deepest first', async () => {
      const repo = await mkdirp(tmpHome, 'repo')
      await mkdirp(repo, '.git')
      const pkg = await mkdirp(repo, 'packages', 'app')

      await mkdirp(repo, '.claude', 'skills')
      await mkdirp(repo, '.agents', 'skills')
      await mkdirp(pkg, '.claude', 'skills')
      await mkdirp(pkg, '.agents', 'skills')

      const roots = getProjectSkillRoots(pkg)

      expect(roots.map(r => r.path)).toEqual([
        path.join(pkg, '.claude', 'skills'),
        path.join(pkg, '.agents', 'skills'),
        path.join(repo, '.claude', 'skills'),
        path.join(repo, '.agents', 'skills'),
      ])
    })

    it('scopes each directory level separately', async () => {
      const repo = await mkdirp(tmpHome, 'repo')
      await mkdirp(repo, '.git')
      const pkg = await mkdirp(repo, 'packages', 'app')
      await mkdirp(pkg, '.claude', 'skills')
      await mkdirp(pkg, '.agents', 'skills')
      await mkdirp(repo, '.claude', 'skills')

      const roots = getProjectSkillRoots(pkg)
      const pkgScopes = new Set(
        roots.filter(r => r.path.startsWith(pkg)).map(r => r.scopeKey),
      )
      const repoScope = roots.find(r => r.path === path.join(repo, '.claude', 'skills'))!

      // Both conventions inside `pkg` share a scope (they collide), but the
      // repo-root level is a different scope (it legitimately overrides).
      expect(pkgScopes.size).toBe(1)
      expect(pkgScopes.has(repoScope.scopeKey)).toBe(false)
    })

    it('only returns directories that exist', async () => {
      const repo = await mkdirp(tmpHome, 'repo')
      await mkdirp(repo, '.git')
      await mkdirp(repo, '.agents', 'skills')

      const roots = getProjectSkillRoots(repo)

      expect(roots.map(r => r.path)).toEqual([
        path.join(repo, '.agents', 'skills'),
      ])
    })

    it('stops at the git root instead of walking to home', async () => {
      const outside = await mkdirp(tmpHome, 'outside')
      await mkdirp(outside, '.agents', 'skills')
      const repo = await mkdirp(outside, 'repo')
      await mkdirp(repo, '.git')
      await mkdirp(repo, '.agents', 'skills')

      const roots = getProjectSkillRoots(repo)

      expect(roots.map(r => r.path)).toEqual([
        path.join(repo, '.agents', 'skills'),
      ])
    })

    it('returns nothing when neither convention is present', async () => {
      const repo = await mkdirp(tmpHome, 'bare-repo')
      await mkdirp(repo, '.git')

      expect(getProjectSkillRoots(repo)).toEqual([])
    })
  })

  describe('--add-dir roots', () => {
    it('returns both conventions in one scope, .claude first', () => {
      const roots = getAddDirSkillRoots('/tmp/added')

      expect(roots.map(r => r.path)).toEqual([
        path.join('/tmp/added', '.claude', 'skills'),
        path.join('/tmp/added', '.agents', 'skills'),
      ])
      expect(new Set(roots.map(r => r.scopeKey)).size).toBe(1)
    })

    it('scopes different added directories separately', () => {
      const a = getAddDirSkillRoots('/tmp/a')
      const b = getAddDirSkillRoots('/tmp/b')

      expect(a[0]!.scopeKey).not.toBe(b[0]!.scopeKey)
    })
  })

  describe('nested discovery candidates', () => {
    it('offers .claude before .agents', () => {
      expect(getNestedSkillDirCandidates('/repo/pkg')).toEqual([
        path.join('/repo/pkg', '.claude', 'skills'),
        path.join('/repo/pkg', '.agents', 'skills'),
      ])
    })
  })

  describe('name collision precedence', () => {
    it('lets .claude take a name .agents is holding', () => {
      expect(outranksClaimedSkill('agents', 'claude')).toBe(true)
    })

    it('leaves the incumbent in place for every other pairing', () => {
      // Same flavor, or the other direction — the caller's root order already
      // ranked these, so the first one loaded keeps the name.
      expect(outranksClaimedSkill('claude', 'agents')).toBe(false)
      expect(outranksClaimedSkill('claude', 'claude')).toBe(false)
      expect(outranksClaimedSkill('agents', 'agents')).toBe(false)
    })

    it('never displaces or is displaced by a flavorless root', () => {
      // Plugin and legacy /commands/ entries have no flavor to rank.
      expect(outranksClaimedSkill(undefined, 'claude')).toBe(false)
      expect(outranksClaimedSkill(undefined, 'agents')).toBe(false)
      expect(outranksClaimedSkill('claude', undefined)).toBe(false)
      expect(outranksClaimedSkill('agents', undefined)).toBe(false)
      expect(outranksClaimedSkill(undefined, undefined)).toBe(false)
    })
  })
})
