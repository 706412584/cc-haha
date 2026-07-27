import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handlePluginsApi } from '../api/plugins.js'
import { handleSkillsApi, listSkillSlashCommands } from '../api/skills.js'

let tmpHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalClaudeConfigDir: string | undefined
let originalCwdState: string

function makeRequest(urlStr: string): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const req = new Request(url.toString(), { method: 'GET' })
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

function makePluginReloadRequest(): { req: Request; url: URL; segments: string[] } {
  const url = new URL('/api/plugins/reload', 'http://localhost:3456')
  const req = new Request(url.toString(), { method: 'POST' })
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

function makePostRequest(
  urlStr: string,
  body: unknown,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const req = new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

async function writeSkill(root: string, skillName: string, content: string): Promise<void> {
  const skillDir = path.join(root, skillName)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
}

describe('Skills API', () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-skills-test-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalCwdState = getCwdState()

    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
    setCwdState(tmpHome)
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-test-setup')
    resetSettingsCache()
  })

  afterEach(async () => {
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-test-teardown')
    resetSettingsCache()
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }

    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }

    setCwdState(originalCwdState)
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('lists user and project skills for the requested cwd', async () => {
    const userSkillsRoot = path.join(tmpHome, '.claude', 'skills')
    const projectRoot = path.join(tmpHome, 'workspace')
    const cwd = path.join(projectRoot, 'packages', 'app')

    await writeSkill(
      userSkillsRoot,
      'user-skill',
      ['---', 'description: User scope', '---', '', '# User skill'].join('\n'),
    )
    await writeSkill(
      path.join(projectRoot, '.claude', 'skills'),
      'project-skill',
      ['---', 'description: Project scope', '---', '', '# Project skill'].join('\n'),
    )

    const { req, url, segments } = makeRequest(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as { skills: Array<{ name: string; source: string }> }
    expect(body.skills).toContainEqual(expect.objectContaining({ name: 'user-skill', source: 'user' }))
    expect(body.skills).toContainEqual(expect.objectContaining({ name: 'project-skill', source: 'project' }))
  })

  it('GET /api/skills/catalog returns curated entries with installed=false initially', async () => {
    const { req, url, segments } = makeRequest('/api/skills/catalog')
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      catalog: Array<{ name: string; installed: boolean; files?: unknown }>
    }
    expect(body.catalog.length).toBeGreaterThan(0)
    const coderabbit = body.catalog.find((entry) => entry.name === 'coderabbit-review')
    expect(coderabbit).toBeDefined()
    expect(coderabbit?.installed).toBe(false)
    // The catalog API must not leak the embedded file contents.
    expect(coderabbit).not.toHaveProperty('files')
  })

  it('POST /api/skills/install writes the skill into the user skills dir and is idempotent', async () => {
    const skillDir = path.join(tmpHome, '.claude', 'skills', 'coderabbit-review')

    const first = makePostRequest('/api/skills/install', { name: 'coderabbit-review' })
    const firstRes = await handleSkillsApi(first.req, first.url, first.segments)
    expect(firstRes.status).toBe(200)
    expect(await firstRes.json()).toEqual({ ok: true, installed: true })

    const installed = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    expect(installed).toContain('name: code-review')

    // Reinstalling must not overwrite and must report alreadyInstalled.
    const second = makePostRequest('/api/skills/install', { name: 'coderabbit-review' })
    const secondRes = await handleSkillsApi(second.req, second.url, second.segments)
    expect(secondRes.status).toBe(200)
    expect(await secondRes.json()).toEqual({ ok: true, alreadyInstalled: true })

    // Catalog now reports it installed.
    const catalog = makeRequest('/api/skills/catalog')
    const catalogRes = await handleSkillsApi(catalog.req, catalog.url, catalog.segments)
    const catalogBody = (await catalogRes.json()) as {
      catalog: Array<{ name: string; installed: boolean }>
    }
    expect(
      catalogBody.catalog.find((entry) => entry.name === 'coderabbit-review')?.installed,
    ).toBe(true)
  })

  it('POST /api/skills/install writes all companion files for a multi-file skill', async () => {
    const skillDir = path.join(tmpHome, '.claude', 'skills', 'stripe-best-practices')

    const res0 = makePostRequest('/api/skills/install', { name: 'stripe-best-practices' })
    const res = await handleSkillsApi(res0.req, res0.url, res0.segments)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, installed: true })

    const skillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    expect(skillMd).toContain('name: stripe-best-practices')
    // Companion reference files land in the references/ subdirectory.
    for (const ref of ['payments.md', 'connect.md', 'billing.md', 'treasury.md']) {
      const refContent = await fs.readFile(
        path.join(skillDir, 'references', ref),
        'utf-8',
      )
      expect(refContent.length).toBeGreaterThan(0)
    }
  })

  it('POST /api/skills/install writes a large reference set (supabase) under references/', async () => {
    const skillDir = path.join(tmpHome, '.claude', 'skills', 'supabase-best-practices')

    const r = makePostRequest('/api/skills/install', { name: 'supabase-best-practices' })
    const res = await handleSkillsApi(r.req, r.url, r.segments)
    expect(res.status).toBe(200)

    const refs = await fs.readdir(path.join(skillDir, 'references'))
    // _sections.md plus the per-rule files across all 8 categories.
    expect(refs.length).toBeGreaterThanOrEqual(30)
    expect(refs).toContain('security-rls-performance.md')
    const rls = await fs.readFile(
      path.join(skillDir, 'references', 'security-rls-performance.md'),
      'utf-8',
    )
    expect(rls).toContain('Optimize RLS Policies')
  })

  it('POST /api/skills/install rejects unknown and missing skill names', async () => {
    const unknown = makePostRequest('/api/skills/install', { name: 'does-not-exist' })
    const unknownRes = await handleSkillsApi(unknown.req, unknown.url, unknown.segments)
    expect(unknownRes.status).toBe(404)

    const missing = makePostRequest('/api/skills/install', {})
    const missingRes = await handleSkillsApi(missing.req, missing.url, missing.segments)
    expect(missingRes.status).toBe(400)
  })

  it('lists user skills installed through a directory symlink or junction', async () => {
    const linkedSkillsRoot = path.join(tmpHome, '.agents', 'skills')
    const userSkillsRoot = path.join(tmpHome, '.claude', 'skills')
    const projectRoot = path.join(tmpHome, 'workspace')
    const cwd = path.join(projectRoot, 'packages', 'app')

    await writeSkill(
      linkedSkillsRoot,
      'linked-skill',
      ['---', 'description: Linked skill', '---', '', '# Linked skill'].join('\n'),
    )
    await fs.mkdir(userSkillsRoot, { recursive: true })
    await fs.symlink(
      path.join(linkedSkillsRoot, 'linked-skill'),
      path.join(userSkillsRoot, 'linked-skill'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    const { req, url, segments } = makeRequest(`/api/skills?cwd=${encodeURIComponent(cwd)}`)
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as { skills: Array<{ name: string; source: string }> }
    expect(body.skills).toContainEqual(expect.objectContaining({ name: 'linked-skill', source: 'user' }))
  })

  it('resolves project skill details from the nearest project skills directory', async () => {
    const projectRoot = path.join(tmpHome, 'workspace')
    const nestedRoot = path.join(projectRoot, 'packages', 'app')
    const nestedSkillsRoot = path.join(nestedRoot, '.claude', 'skills')
    const parentSkillsRoot = path.join(projectRoot, '.claude', 'skills')

    await writeSkill(
      parentSkillsRoot,
      'shared-skill',
      ['---', 'description: Parent version', '---', '', 'parent body'].join('\n'),
    )
    await writeSkill(
      nestedSkillsRoot,
      'shared-skill',
      ['---', 'description: Child version', '---', '', 'child body'].join('\n'),
    )

    const { req, url, segments } = makeRequest(
      `/api/skills/detail?source=project&name=shared-skill&cwd=${encodeURIComponent(nestedRoot)}`,
    )
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      detail: { meta: { description: string }; skillRoot: string; files: Array<{ path: string; body?: string }> }
    }

    expect(body.detail.meta.description).toBe('Child version')
    expect(body.detail.skillRoot).toBe(path.join(nestedSkillsRoot, 'shared-skill'))
    expect(body.detail.files).toContainEqual(
      expect.objectContaining({ path: 'SKILL.md', body: 'child body' }),
    )
  })

  it('does not expose a mismatched market marker on a user skill', async () => {
    const userSkillsRoot = path.join(tmpHome, '.claude', 'skills')
    const skillDir = path.join(userSkillsRoot, 'skill-a')
    await writeSkill(
      userSkillsRoot,
      'skill-a',
      ['---', 'description: User skill', '---', '', '# Skill A'].join('\n'),
    )
    await fs.writeFile(
      path.join(skillDir, '.market-meta.json'),
      JSON.stringify({
        id: 'clawhub:skill-b',
        source: 'clawhub',
        slug: 'skill-b',
        installedAt: new Date(0).toISOString(),
        fileCount: 1,
      }),
    )

    const { req, url, segments } = makeRequest('/api/skills/detail?source=user&name=skill-a')
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as { detail: { marketMeta?: unknown } }
    expect(body.detail.marketMeta).toBeUndefined()
  })

  it('never exposes a market marker on a project skill', async () => {
    const projectRoot = path.join(tmpHome, 'workspace')
    const projectSkillsRoot = path.join(projectRoot, '.claude', 'skills')
    const skillDir = path.join(projectSkillsRoot, 'project-skill')
    await writeSkill(
      projectSkillsRoot,
      'project-skill',
      ['---', 'description: Project skill', '---', '', '# Project skill'].join('\n'),
    )
    await fs.writeFile(
      path.join(skillDir, '.market-meta.json'),
      JSON.stringify({
        id: 'clawhub:project-skill',
        source: 'clawhub',
        slug: 'project-skill',
        installedAt: new Date(0).toISOString(),
        fileCount: 1,
      }),
    )

    const { req, url, segments } = makeRequest(
      `/api/skills/detail?source=project&name=project-skill&cwd=${encodeURIComponent(projectRoot)}`,
    )
    const res = await handleSkillsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as { detail: { marketMeta?: unknown } }
    expect(body.detail.marketMeta).toBeUndefined()
  })

  it('lists plugin skills after reload rereads an external enable toggle', async () => {
    const marketplaceRoot = path.join(tmpHome, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'draw')
    const pluginsDir = path.join(tmpHome, '.claude', 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'skills', 'render'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'draw',
        version: '1.0.0',
        description: 'Drawing plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'skills', 'render', 'SKILL.md'),
      [
        '---',
        'description: Render with the drawing plugin.',
        '---',
        '',
        '# Render',
      ].join('\n'),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'draw',
            source: './plugins/draw',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json')
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': false,
        },
      }),
      'utf-8',
    )

    const initial = makeRequest('/api/skills')
    const initialRes = await handleSkillsApi(initial.req, initial.url, initial.segments)
    const initialBody = await initialRes.json() as {
      skills: Array<{ name: string; source: string }>
    }
    expect(initialBody.skills).not.toContainEqual(
      expect.objectContaining({ name: 'draw:render', source: 'plugin' }),
    )

    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': true,
        },
      }),
      'utf-8',
    )

    const reload = makePluginReloadRequest()
    const reloadRes = await handlePluginsApi(reload.req, reload.url, reload.segments)
    expect(reloadRes.status).toBe(200)

    const after = makeRequest('/api/skills')
    const afterRes = await handleSkillsApi(after.req, after.url, after.segments)
    const afterBody = await afterRes.json() as {
      skills: Array<{ name: string; source: string; description: string }>
    }

    expect(afterBody.skills).toContainEqual(
      expect.objectContaining({
        name: 'draw:render',
        source: 'plugin',
        description: 'Render with the drawing plugin.',
      }),
    )
  })

  it('lists plugin skills after an external CLI install updates portable config on disk', async () => {
    const marketplaceRoot = path.join(tmpHome, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'draw')
    const pluginsDir = path.join(tmpHome, '.claude', 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await writeSkill(
      path.join(pluginRoot, 'skills'),
      'render',
      ['---', 'description: Render with the drawing plugin.', '---', '', '# Render'].join('\n'),
    )
    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'draw',
        version: '1.0.0',
        description: 'Drawing plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'draw',
            source: './plugins/draw',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json')
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': false,
        },
      }),
      'utf-8',
    )

    const initial = makeRequest('/api/skills')
    const initialRes = await handleSkillsApi(initial.req, initial.url, initial.segments)
    const initialBody = await initialRes.json() as {
      skills: Array<{ name: string; source: string }>
    }
    expect(initialBody.skills).not.toContainEqual(
      expect.objectContaining({ name: 'draw:render', source: 'plugin' }),
    )

    // Simulates the embedded terminal running the CLI against the same
    // CLAUDE_CONFIG_DIR while the desktop server process stays alive.
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': true,
        },
      }),
      'utf-8',
    )

    const after = makeRequest('/api/skills')
    const afterRes = await handleSkillsApi(after.req, after.url, after.segments)
    const afterBody = await afterRes.json() as {
      skills: Array<{ name: string; source: string; description: string }>
    }

    expect(afterBody.skills).toContainEqual(
      expect.objectContaining({
        name: 'draw:render',
        source: 'plugin',
        description: 'Render with the drawing plugin.',
      }),
    )
  })

  describe('.agents/skills convention', () => {
    it('lists user and project skills from .agents, tagged with rootFlavor', async () => {
      const projectRoot = path.join(tmpHome, 'workspace')
      await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true })

      await writeSkill(
        path.join(tmpHome, '.agents', 'skills'),
        'agents-user-skill',
        ['---', 'description: Installed by Codex', '---', '', '# Shared'].join('\n'),
      )
      await writeSkill(
        path.join(projectRoot, '.agents', 'skills'),
        'agents-project-skill',
        ['---', 'description: Checked into the repo', '---', '', '# Repo'].join('\n'),
      )

      const { req, url, segments } = makeRequest(
        `/api/skills?cwd=${encodeURIComponent(projectRoot)}`,
      )
      const res = await handleSkillsApi(req, url, segments)

      expect(res.status).toBe(200)
      const body = await res.json() as {
        skills: Array<{ name: string; source: string; rootFlavor?: string }>
      }
      expect(body.skills).toContainEqual(
        expect.objectContaining({
          name: 'agents-user-skill',
          source: 'user',
          rootFlavor: 'agents',
        }),
      )
      expect(body.skills).toContainEqual(
        expect.objectContaining({
          name: 'agents-project-skill',
          source: 'project',
          rootFlavor: 'agents',
        }),
      )
    })

    it('tags .claude skills as the claude flavor', async () => {
      await writeSkill(
        path.join(tmpHome, '.claude', 'skills'),
        'native-skill',
        ['---', 'description: Native', '---', '', '# Native'].join('\n'),
      )

      const { req, url, segments } = makeRequest('/api/skills')
      const res = await handleSkillsApi(req, url, segments)
      const body = await res.json() as {
        skills: Array<{ name: string; rootFlavor?: string }>
      }

      expect(body.skills).toContainEqual(
        expect.objectContaining({ name: 'native-skill', rootFlavor: 'claude' }),
      )
    })

    it('reports a name present in both user conventions once, as .claude', async () => {
      // A cwd whose own tree holds no skills, so only the user roots contribute
      // and the two spellings of the user scope are the only candidates.
      const emptyWorkspace = path.join(tmpHome, 'workspace-without-skills')
      await fs.mkdir(path.join(emptyWorkspace, '.git'), { recursive: true })

      await writeSkill(
        path.join(tmpHome, '.claude', 'skills'),
        'dup',
        ['---', 'description: The claude one', '---', '', '# Dup'].join('\n'),
      )
      await writeSkill(
        path.join(tmpHome, '.agents', 'skills'),
        'dup',
        ['---', 'description: The agents one', '---', '', '# Dup'].join('\n'),
      )

      const { req, url, segments } = makeRequest(
        `/api/skills?cwd=${encodeURIComponent(emptyWorkspace)}`,
      )
      const res = await handleSkillsApi(req, url, segments)
      const body = await res.json() as {
        skills: Array<{ name: string; description: string; rootFlavor?: string }>
      }

      const matches = body.skills.filter((s) => s.name === 'dup')
      expect(matches).toHaveLength(1)
      expect(matches[0]).toEqual(
        expect.objectContaining({
          description: 'The claude one',
          rootFlavor: 'claude',
        }),
      )
    })

    it('serves detail for a skill that only exists under .agents', async () => {
      await writeSkill(
        path.join(tmpHome, '.agents', 'skills'),
        'agents-only',
        ['---', 'description: Only in agents', '---', '', '# Body'].join('\n'),
      )

      const { req, url, segments } = makeRequest(
        '/api/skills/detail?source=user&name=agents-only',
      )
      const res = await handleSkillsApi(req, url, segments)

      expect(res.status).toBe(200)
      const body = await res.json() as {
        detail: { meta: { name: string; rootFlavor?: string }; skillRoot: string }
      }
      expect(body.detail.meta.name).toBe('agents-only')
      expect(body.detail.skillRoot).toBe(
        path.join(tmpHome, '.agents', 'skills', 'agents-only'),
      )
      // Detail must report the same flavor the listing does, or the badge
      // flickers when the user opens a skill.
      expect(body.detail.meta.rootFlavor).toBe('agents')
    })

    it('reports the claude flavor in detail for a .claude skill', async () => {
      await writeSkill(
        path.join(tmpHome, '.claude', 'skills'),
        'native-only',
        ['---', 'description: Native', '---', '', '# Body'].join('\n'),
      )

      const { req, url, segments } = makeRequest(
        '/api/skills/detail?source=user&name=native-only',
      )
      const res = await handleSkillsApi(req, url, segments)
      const body = await res.json() as {
        detail: { meta: { rootFlavor?: string } }
      }

      expect(body.detail.meta.rootFlavor).toBe('claude')
    })

    it('ignores .agents when the feature is switched off', async () => {
      process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR = '1'
      try {
        await writeSkill(
          path.join(tmpHome, '.agents', 'skills'),
          'agents-only',
          ['---', 'description: Only in agents', '---', '', '# Body'].join('\n'),
        )

        const { req, url, segments } = makeRequest('/api/skills')
        const res = await handleSkillsApi(req, url, segments)
        const body = await res.json() as { skills: Array<{ name: string }> }

        expect(body.skills.map((s) => s.name)).not.toContain('agents-only')
      } finally {
        delete process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR
      }
    })
  })

  /**
   * The slash command list feeds the desktop composer menu, so it has to agree
   * with the CLI on which file a name resolves to — otherwise the menu
   * describes one skill and running it executes another.
   *
   * See the matching cases in
   * src/skills/__tests__/agentSkillsDiscovery.test.ts.
   */
  describe('slash command name collisions', () => {
    async function repoWith(
      skills: Array<{ root: string; marker: string }>,
    ): Promise<string> {
      const repo = path.join(tmpHome, 'workspace')
      await fs.mkdir(path.join(repo, '.git'), { recursive: true })
      for (const { root, marker } of skills) {
        await writeSkill(
          root.replace('<repo>', repo),
          'deploy',
          ['---', `description: ${marker}`, '---', '', '# Deploy'].join('\n'),
        )
      }
      return repo
    }

    it('prefers a project .claude skill over a user .agents skill', async () => {
      const repo = await repoWith([
        { root: path.join(tmpHome, '.agents', 'skills'), marker: 'User agents' },
        { root: path.join('<repo>', '.claude', 'skills'), marker: 'Project claude' },
      ])

      const commands = await listSkillSlashCommands(repo)
      const matches = commands.filter((c) => c.name === 'deploy')

      expect(matches).toHaveLength(1)
      expect(matches[0]!.description).toBe('Project claude')
    })

    it('prefers a user .claude skill over a project .agents skill', async () => {
      const repo = await repoWith([
        { root: path.join(tmpHome, '.claude', 'skills'), marker: 'User claude' },
        { root: path.join('<repo>', '.agents', 'skills'), marker: 'Project agents' },
      ])

      const commands = await listSkillSlashCommands(repo)
      const matches = commands.filter((c) => c.name === 'deploy')

      expect(matches).toHaveLength(1)
      expect(matches[0]!.description).toBe('User claude')
    })

    it('keeps the user copy when both scopes use .claude', async () => {
      const repo = await repoWith([
        { root: path.join(tmpHome, '.claude', 'skills'), marker: 'User claude' },
        { root: path.join('<repo>', '.claude', 'skills'), marker: 'Project claude' },
      ])

      const commands = await listSkillSlashCommands(repo)
      const matches = commands.filter((c) => c.name === 'deploy')

      expect(matches).toHaveLength(1)
      expect(matches[0]!.description).toBe('User claude')
    })

    it('lists no duplicate names at all', async () => {
      const repo = await repoWith([
        { root: path.join(tmpHome, '.claude', 'skills'), marker: 'User claude' },
        { root: path.join(tmpHome, '.agents', 'skills'), marker: 'User agents' },
        { root: path.join('<repo>', '.claude', 'skills'), marker: 'Repo claude' },
        { root: path.join('<repo>', '.agents', 'skills'), marker: 'Repo agents' },
      ])

      const names = (await listSkillSlashCommands(repo)).map((c) => c.name)

      expect(names.filter((n) => n === 'deploy')).toHaveLength(1)
      expect(new Set(names).size).toBe(names.length)
    })
  })
})
