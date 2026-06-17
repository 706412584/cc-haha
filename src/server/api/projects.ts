/**
 * /api/projects/* — endpoints derived from the on-disk projects directory
 * (`~/.claude/projects/<sanitized-workDir>/...`) plus git state.
 *
 * Currently exposes:
 *   GET  /api/projects/recent-activity?workDir=<absolute-path>
 *   POST /api/projects/sessions/clear  body: { projectId }
 *
 * The first returns a "what was the user just doing in this project" snapshot
 * for the desktop welcome screen. The second permanently deletes every .jsonl
 * session file under the named project id (and removes the now-empty project
 * directory) so the project disappears from the sidebar/listings.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getRecentActivity } from '../services/projectActivityService.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { sanitizePath } from '../../utils/path.js'

function getProjectsDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'projects')
}

function isValidProjectId(projectId: string): boolean {
  return (
    typeof projectId === 'string' &&
    projectId.length > 0 &&
    !projectId.includes('\0') &&
    !projectId.includes('/') &&
    !projectId.includes('\\') &&
    projectId !== '.' &&
    projectId !== '..'
  )
}

async function clearProjectSessions(req: Request): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  const { projectId, workDir } = body as { projectId?: unknown; workDir?: unknown }

  // Accept either projectId (already sanitized) or workDir (an absolute path
  // that we sanitize ourselves). The desktop client passes workDir; backend
  // tooling can pass projectId directly.
  let resolvedId: string
  if (typeof projectId === 'string' && projectId.length > 0) {
    if (!isValidProjectId(projectId)) {
      throw ApiError.badRequest('Invalid projectId')
    }
    resolvedId = projectId
  } else if (typeof workDir === 'string' && workDir.length > 0 && path.isAbsolute(workDir)) {
    resolvedId = sanitizePath(workDir)
    if (!isValidProjectId(resolvedId)) {
      throw ApiError.badRequest('workDir sanitized to an invalid id')
    }
  } else {
    throw ApiError.badRequest('Provide projectId or absolute workDir')
  }

  const projectsDir = path.resolve(getProjectsDir())
  const projectDir = path.join(projectsDir, resolvedId)

  // Defence in depth: even though isValidProjectId rejects path separators,
  // verify the resolved directory still sits under the projects dir.
  const resolvedProjectDir = path.resolve(projectDir)
  if (
    resolvedProjectDir !== path.join(projectsDir, resolvedId) ||
    !resolvedProjectDir.startsWith(projectsDir + path.sep)
  ) {
    throw ApiError.badRequest('projectId resolves outside projects directory')
  }

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(resolvedProjectDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Response.json({ ok: true, deletedSessions: 0, projectDirRemoved: false })
    }
    throw error
  }

  let deletedSessions = 0
  let nonSessionEntries = 0
  for (const entry of entries) {
    if (!entry.isFile()) {
      // Sub-directories (e.g. workspace snapshots tied to a session) are
      // intentionally preserved — they may hold user state we shouldn't drop.
      nonSessionEntries += 1
      continue
    }
    // Per-session artefacts: the JSONL transcript, plus its sidecar summary.
    if (entry.name.endsWith('.jsonl')) {
      try {
        await fs.unlink(path.join(resolvedProjectDir, entry.name))
        deletedSessions += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      continue
    }
    if (entry.name.endsWith('.summary.json')) {
      try {
        await fs.unlink(path.join(resolvedProjectDir, entry.name))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      continue
    }
    nonSessionEntries += 1
  }

  // If the directory is now empty (no leftover memory/, etc.), remove it so
  // the project drops off the sidebar entirely.
  let projectDirRemoved = false
  if (nonSessionEntries === 0) {
    try {
      await fs.rmdir(resolvedProjectDir)
      projectDirRemoved = true
    } catch {
      // Race with another writer or non-empty after all — leave directory.
    }
  }

  return Response.json({ ok: true, deletedSessions, projectDirRemoved })
}

export async function handleProjectsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]
    if (sub === 'recent-activity') {
      if (req.method !== 'GET') {
        throw new ApiError(
          405,
          `Method ${req.method} not allowed on /api/projects/recent-activity`,
          'METHOD_NOT_ALLOWED',
        )
      }
      const workDir = url.searchParams.get('workDir')
      if (!workDir || !workDir.trim()) {
        throw ApiError.badRequest('Missing required query parameter: workDir')
      }
      const excludeSessionId = url.searchParams.get('excludeSessionId') || undefined
      const result = await getRecentActivity(workDir, {
        ...(excludeSessionId ? { excludeSessionId } : {}),
      })
      return Response.json(result)
    }

    if (sub === 'sessions' && segments[3] === 'clear') {
      if (req.method !== 'POST') {
        throw new ApiError(
          405,
          `Method ${req.method} not allowed on /api/projects/sessions/clear`,
          'METHOD_NOT_ALLOWED',
        )
      }
      return await clearProjectSessions(req)
    }

    throw ApiError.notFound(`Unknown projects endpoint: ${sub ?? '(root)'}`)
  } catch (error) {
    return errorResponse(error)
  }
}
