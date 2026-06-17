/**
 * Project Rules (CLAUDE.md) REST API
 *
 * GET  /api/project-rules       — Get CLAUDE.md file paths and existence status
 * POST /api/project-rules/create — Create a CLAUDE.md file if it doesn't exist
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'

export async function handleProjectRulesApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  const sub = segments[2]

  if (req.method === 'GET' && !sub) {
    return await getProjectRules(url)
  }

  if (req.method === 'POST' && sub === 'create') {
    return await createProjectRulesFile(req, url)
  }

  return Response.json(
    { error: 'Not Found', message: `Unknown project-rules endpoint` },
    { status: 404 },
  )
}

async function getProjectRules(url: URL): Promise<Response> {
  const cwd = url.searchParams.get('cwd') || getCwd()

  const userFile = path.join(getClaudeConfigHomeDir(), 'CLAUDE.md')
  const projectFile = path.join(cwd, '.claude', 'CLAUDE.md')

  const [userExists, projectExists] = await Promise.all([
    fileExists(userFile),
    fileExists(projectFile),
  ])

  return Response.json({
    projectFile: { path: projectFile, exists: projectExists },
    userFile: { path: userFile, exists: userExists },
  })
}

async function createProjectRulesFile(req: Request, url: URL): Promise<Response> {
  let body: { scope?: string; cwd?: string }
  try {
    body = await req.json() as { scope?: string; cwd?: string }
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const scope = body.scope
  const cwd = body.cwd || url.searchParams.get('cwd') || getCwd()

  let filePath: string
  if (scope === 'project') {
    filePath = path.join(cwd, '.claude', 'CLAUDE.md')
  } else if (scope === 'user') {
    filePath = path.join(getClaudeConfigHomeDir(), 'CLAUDE.md')
  } else {
    return Response.json({ error: 'Invalid scope, must be "project" or "user"' }, { status: 400 })
  }

  // Don't overwrite existing files
  if (await fileExists(filePath)) {
    return Response.json({ ok: true, path: filePath, created: false })
  }

  // Create directory if needed
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  // Create file with template content
  const template = scope === 'project'
    ? '# Project Rules\n\n<!-- Add project-specific instructions here. These are loaded into every conversation. -->\n'
    : '# User Rules\n\n<!-- Add global instructions here. These apply to all projects. -->\n'

  await fs.writeFile(filePath, template, 'utf-8')

  return Response.json({ ok: true, path: filePath, created: true })
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
