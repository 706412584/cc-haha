import { describe, it, expect, mock, beforeEach } from 'bun:test'
import * as path from 'path'

const MOCK_CLAUDE_HOME = path.join('/mock', 'home', '.claude')
const MOCK_PROJECT = path.join('/mock', 'project')
const MOCK_PROJECTS_DIR = path.join(MOCK_CLAUDE_HOME, 'projects')

// Mock dependencies
mock.module('../../utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: () => MOCK_CLAUDE_HOME,
}))

mock.module('../../utils/cwd.js', () => ({
  getCwd: () => MOCK_PROJECT,
}))

mock.module('../../utils/git.js', () => ({
  findGitRoot: (cwd: string) => cwd,
  findCanonicalGitRoot: (cwd: string) => cwd,
}))

const mockFiles = new Set<string>()
const mockFileContents = new Map<string, string>()
const mockDirs = new Map<string, string[]>()

mock.module('fs/promises', () => ({
  access: async (filePath: string) => {
    if (!mockFiles.has(filePath)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
  },
  realpath: async (filePath: string) => filePath,
  stat: async (filePath: string) => {
    if (!mockFiles.has(filePath)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const content = mockFileContents.get(filePath) ?? ''
    return { isDirectory: () => false, isFile: () => true, dev: 1, ino: filePath.length, size: content.length, mtimeMs: 1 }
  },
  lstat: async (filePath: string) => {
    if (!mockFiles.has(filePath)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }
  },
  open: async (filePath: string) => {
    const content = mockFileContents.get(filePath) ?? ''
    const stat = { isFile: () => true, dev: 1, ino: filePath.length, size: content.length, mtimeMs: 1 }
    return { stat: async () => stat, readFile: async () => content, close: async () => {} }
  },
  mkdir: async () => {},
  writeFile: async (filePath: string) => {
    mockFiles.add(filePath)
  },
  readFile: async (filePath: string) => mockFileContents.get(filePath) ?? '{}',
  readdir: async (dirPath: string, _opts?: unknown) => {
    // Check all registered mock dirs
    const entries = mockDirs.get(dirPath)
    if (entries) {
      // If dirPath ends with 'projects', return as directories
      if (dirPath.endsWith('projects')) {
        return entries.map(name => ({ name, isDirectory: () => true, isFile: () => false }))
      }
      // Otherwise return as files
      return entries.map(name => ({ name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }))
    }
    // Default: throw ENOENT
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  },
}))

import { handleProjectRulesApi } from '../api/project-rules'

describe('project-rules API', () => {
  beforeEach(() => {
    mockFiles.clear()
    mockFileContents.clear()
    mockDirs.clear()
  })

  it('GET /api/project-rules returns current project and user files', async () => {
    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: unknown[]; userFiles: unknown[]; cwd: string }

    expect(data.cwd).toBe(MOCK_PROJECT)
    expect(data.projects.length).toBeGreaterThanOrEqual(1)
    expect(data.userFiles.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /api/project-rules marks current project', async () => {
    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: Array<{ isCurrent: boolean }> }

    expect(data.projects[0].isCurrent).toBe(true)
  })

  it('GET /api/project-rules includes current project in response', async () => {
    // Even without other projects in the dir, current project should appear
    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: Array<{ id: string; isCurrent: boolean }> }

    expect(data.projects.length).toBeGreaterThanOrEqual(1)
    const current = data.projects.find(p => p.isCurrent)
    expect(current).toBeDefined()
  })

  it('GET /api/project-rules discovers and normalizes Cursor project rules', async () => {
    const cursorRulesDir = path.join(MOCK_PROJECT, '.cursor', 'rules')
    const cursorRulePath = path.join(cursorRulesDir, 'typescript.mdc')
    mockDirs.set(cursorRulesDir, ['typescript.mdc'])
    mockFiles.add(cursorRulePath)
    mockFileContents.set(cursorRulePath, '# TypeScript\n\nUse strict types.')

    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as {
      projects: Array<{
        isCurrent: boolean
        normalizedRules: Array<{
          source: string
          originalPath: string
          canonicalPath: string
          fingerprint: string
          isNative: boolean
          scopes: string[]
          provenance: { provider: string; label: string }
        }>
      }>
    }

    const current = data.projects.find(project => project.isCurrent)
    const rule = current?.normalizedRules.find(item => item.source === 'cursor')
    expect(rule).toMatchObject({
      source: 'cursor',
      originalPath: cursorRulePath,
      canonicalPath: 'project/rules/typescript',
      isNative: false,
      scopes: ['project'],
      provenance: { provider: 'Cursor', label: '.cursor/rules/typescript.mdc' },
    })
    expect(rule?.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('GET /api/project-rules federates all providers with native-first duplicate and conflict status', async () => {
    const nativePath = path.join(MOCK_PROJECT, 'CLAUDE.md')
    const cursorPath = path.join(MOCK_PROJECT, '.cursorrules')
    const windsurfPath = path.join(MOCK_PROJECT, '.windsurfrules')
    const copilotPath = path.join(MOCK_PROJECT, '.github', 'copilot-instructions.md')
    const sharedContent = '# Project rules\n\nUse bun.'
    for (const [filePath, content] of [
      [nativePath, sharedContent],
      [cursorPath, sharedContent],
      [windsurfPath, '# Project rules\n\nUse npm.'],
      [copilotPath, sharedContent],
    ] as const) {
      mockFiles.add(filePath)
      mockFileContents.set(filePath, content)
    }

    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const res = await handleProjectRulesApi(
      new Request(url, { method: 'GET' }),
      url,
      ['api', 'project-rules'],
    )
    const data = await res.json() as {
      projects: Array<{
        isCurrent: boolean
        normalizedRules: Array<{
          source: string
          canonicalPath: string
          isNative: boolean
          status: string
          relatedRulePaths: string[]
        }>
      }>
    }
    const rules = data.projects.find(project => project.isCurrent)?.normalizedRules ?? []

    expect(rules.map(rule => rule.source)).toEqual(['claude', 'cursor', 'windsurf', 'copilot'])
    expect(rules.every(rule => rule.canonicalPath === 'project/global')).toBe(true)
    expect(rules.find(rule => rule.source === 'claude')).toMatchObject({ isNative: true, status: 'active' })
    expect(rules.find(rule => rule.source === 'cursor')?.status).toBe('overridden-by-native')
    expect(rules.find(rule => rule.source === 'copilot')?.status).toBe('overridden-by-native')
    expect(rules.find(rule => rule.source === 'windsurf')?.status).toBe('conflict')
    expect(rules.find(rule => rule.source === 'windsurf')?.relatedRulePaths).toContain(nativePath)
  })

  it('normalizes Copilot .instructions.md and Cursor .mdc names to the same canonical path', async () => {
    const cursorDir = path.join(MOCK_PROJECT, '.cursor', 'rules')
    const copilotDir = path.join(MOCK_PROJECT, '.github', 'instructions')
    const cursorPath = path.join(cursorDir, 'testing.mdc')
    const copilotPath = path.join(copilotDir, 'testing.instructions.md')
    mockDirs.set(cursorDir, ['testing.mdc'])
    mockDirs.set(copilotDir, ['testing.instructions.md'])
    for (const filePath of [cursorPath, copilotPath]) {
      mockFiles.add(filePath)
      mockFileContents.set(filePath, filePath === cursorPath ? 'Use bun test.' : 'Use npm test.')
    }

    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const res = await handleProjectRulesApi(new Request(url), url, ['api', 'project-rules'])
    const data = await res.json() as {
      projects: Array<{ isCurrent: boolean; normalizedRules: Array<{ source: string; canonicalPath: string; status: string }> }>
    }
    const rules = data.projects.find(project => project.isCurrent)?.normalizedRules ?? []
    expect(rules.find(rule => rule.source === 'cursor')?.canonicalPath).toBe('project/rules/testing')
    expect(rules.find(rule => rule.source === 'copilot')).toMatchObject({
      canonicalPath: 'project/rules/testing',
      status: 'conflict',
    })
  })

  it('GET /api/project-rules detects existing CLAUDE.md in project root', async () => {
    const rootMd = path.join(MOCK_PROJECT, 'CLAUDE.md')
    mockFiles.add(rootMd)

    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: Array<{ files: Array<{ label: string; exists: boolean }> }> }

    const currentProject = data.projects[0]
    const rootFile = currentProject.files.find(f => f.label === 'CLAUDE.md')
    expect(rootFile?.exists).toBe(true)
  })

  it('POST /api/project-rules/create creates project-root CLAUDE.md', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'project-root', cwd: MOCK_PROJECT }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    const data = await res.json() as { ok: boolean; created: boolean; path: string }

    expect(data.ok).toBe(true)
    expect(data.created).toBe(true)
    expect(data.path).toBe(path.join(MOCK_PROJECT, 'CLAUDE.md'))
  })

  it('POST /api/project-rules/create with invalid scope returns 400', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'invalid' }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/project-rules/create rejects path traversal in filename', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'project-root', cwd: MOCK_PROJECT, filename: '../../../escaped.md' }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('Invalid filename')
  })

  it('POST /api/project-rules/create rejects absolute filename', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'project-rules', cwd: MOCK_PROJECT, filename: path.join(MOCK_CLAUDE_HOME, 'evil.md') }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/project-rules/create does not overwrite existing file', async () => {
    const userPath = path.join(MOCK_CLAUDE_HOME, 'CLAUDE.md')
    mockFiles.add(userPath)

    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request(url, {
        method: 'POST',
        body: JSON.stringify({ scope: 'user' }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    const data = await res.json() as { ok: boolean; created: boolean }

    expect(data.ok).toBe(true)
    expect(data.created).toBe(false)
  })

  it('GET /api/project-rules lists projects without any rules files (regression: previously filtered)', async () => {
    // Current project has no rules at all (no CLAUDE.md anywhere).
    // It must still appear so the user can create rules from there.
    const url = new URL(`http://localhost/api/project-rules?cwd=${encodeURIComponent(MOCK_PROJECT)}`)
    const req = new Request(url, { method: 'GET' })
    const res = await handleProjectRulesApi(req, url, ['api', 'project-rules'])
    const data = await res.json() as { projects: Array<{ isCurrent: boolean; files: Array<{ exists: boolean }> }> }

    expect(data.projects).toHaveLength(1)
    const project = data.projects[0]!
    expect(project.isCurrent).toBe(true)
    // Confirm the test setup: no rules file actually exists.
    expect(project.files.some(f => f.exists)).toBe(false)
  })
})
