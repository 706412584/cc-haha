import { lstat, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getProjectDirsUpToHome } from '../markdownConfigLoader.js'
import { findGitRoot } from '../git.js'
import { parseWorkflowScript } from './meta.js'
import { getUserWorkflowsDir } from './paths.js'

export type WorkflowSaveScope = 'user' | 'project'

export type WorkflowSaveResult =
  | { name: string; filePath: string }
  | { error: string }

/**
 * Save a run's script as a `/name` command.
 *
 * Refuses to write through a symlink. For the project scope the check is
 * wider than for the personal one: `.claude` there is repo-controlled, so a
 * symlinked `.claude` or `.claude/workflows` could redirect the write out of
 * the repository entirely. A `~/.claude` managed by a dotfiles tool is a
 * normal setup, so only the target file itself is checked there.
 */
export async function saveWorkflowScript(params: {
  script: string
  scope: WorkflowSaveScope
  cwd?: string
}): Promise<WorkflowSaveResult> {
  const parsed = parseWorkflowScript(params.script)
  if ('error' in parsed) return { error: parsed.error }

  const cwd = params.cwd ?? getOriginalCwd()
  const dir =
    params.scope === 'project'
      ? resolveProjectWorkflowsDir(cwd)
      : getUserWorkflowsDir()

  if (params.scope === 'project') {
    for (const candidate of [
      join(dirOf(dir), '.claude'),
      dir,
      join(dir, `${parsed.meta.name}.js`),
    ]) {
      const link = await isSymlink(candidate)
      if (link) return { error: `Refusing to write through a symlink: ${candidate}` }
    }
  } else if (await isSymlink(join(dir, `${parsed.meta.name}.js`))) {
    return {
      error: `Refusing to write through a symlink: ${join(dir, `${parsed.meta.name}.js`)}`,
    }
  }

  const filePath = join(dir, `${parsed.meta.name}.js`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, params.script, 'utf8')
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    }
  }
  return { name: parsed.meta.name, filePath }
}

/**
 * Where a project save lands in a monorepo.
 *
 * The closest existing `.claude/workflows` between cwd and the repo root wins,
 * so a workflow saved while working in `packages/api` stays with that package
 * instead of being hoisted to the root and shown to every other package.
 */
export function resolveProjectWorkflowsDir(cwd: string): string {
  const existing = safeProjectDirs(cwd)
  if (existing.length > 0) return existing[0]!
  const root = findGitRoot(cwd) ?? cwd
  return join(root, '.claude', 'workflows')
}

function safeProjectDirs(cwd: string): string[] {
  try {
    return getProjectDirsUpToHome('workflows', cwd)
  } catch {
    return []
  }
}

function dirOf(workflowsDir: string): string {
  // `<x>/.claude/workflows` → `<x>`; the caller re-appends `.claude`.
  return join(workflowsDir, '..', '..')
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}
