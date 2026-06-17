import { describe, it, expect, mock, beforeEach } from 'bun:test'
import * as path from 'path'

// Mock dependencies
mock.module('../../utils/envUtils.js', () => ({
  getClaudeConfigHomeDir: () => '/mock/home/.claude',
}))

mock.module('../../utils/cwd.js', () => ({
  getCwd: () => '/mock/project',
}))

const mockFiles = new Set<string>()

mock.module('fs/promises', () => ({
  access: async (filePath: string) => {
    if (!mockFiles.has(filePath)) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
  },
  mkdir: async () => {},
  writeFile: async (filePath: string) => {
    mockFiles.add(filePath)
  },
}))

import { handleProjectRulesApi } from '../api/project-rules'

function makeReq(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/project-rules', {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

describe('project-rules API', () => {
  beforeEach(() => {
    mockFiles.clear()
  })

  it('GET /api/project-rules returns file paths with existence status', async () => {
    const url = new URL('http://localhost/api/project-rules?cwd=/mock/project')
    const res = await handleProjectRulesApi(
      makeReq('GET'),
      url,
      ['api', 'project-rules'],
    )
    const data = await res.json() as { projectFile: { path: string; exists: boolean }; userFile: { path: string; exists: boolean } }

    expect(data.projectFile.path).toContain('CLAUDE.md')
    expect(data.projectFile.exists).toBe(false)
    expect(data.userFile.path).toContain('CLAUDE.md')
    expect(data.userFile.exists).toBe(false)
  })

  it('GET /api/project-rules shows existing files', async () => {
    const projectPath = path.join('/mock/project', '.claude', 'CLAUDE.md')
    mockFiles.add(projectPath)

    const url = new URL('http://localhost/api/project-rules?cwd=/mock/project')
    const res = await handleProjectRulesApi(
      makeReq('GET'),
      url,
      ['api', 'project-rules'],
    )
    const data = await res.json() as { projectFile: { path: string; exists: boolean }; userFile: { path: string; exists: boolean } }

    expect(data.projectFile.exists).toBe(true)
    expect(data.userFile.exists).toBe(false)
  })

  it('POST /api/project-rules/create creates user file', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request('http://localhost/api/project-rules/create', {
        method: 'POST',
        body: JSON.stringify({ scope: 'user' }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )
    const data = await res.json() as { ok: boolean; created: boolean; path: string }

    expect(data.ok).toBe(true)
    expect(data.created).toBe(true)
    expect(data.path).toContain('CLAUDE.md')
  })

  it('POST /api/project-rules/create with invalid scope returns 400', async () => {
    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request('http://localhost/api/project-rules/create', {
        method: 'POST',
        body: JSON.stringify({ scope: 'invalid' }),
      }),
      url,
      ['api', 'project-rules', 'create'],
    )

    expect(res.status).toBe(400)
  })

  it('POST /api/project-rules/create does not overwrite existing file', async () => {
    const userPath = path.join('/mock/home/.claude', 'CLAUDE.md')
    mockFiles.add(userPath)

    const url = new URL('http://localhost/api/project-rules/create')
    const res = await handleProjectRulesApi(
      new Request('http://localhost/api/project-rules/create', {
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
})
