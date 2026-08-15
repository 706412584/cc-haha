import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { getProjectDirsUpToHome } from '../markdownConfigLoader.js'
import { getBundledWorkflows } from './bundled/index.js'
import { loadPluginWorkflows } from './pluginWorkflows.js'
import { WORKFLOW_SCRIPT_MAX_BYTES } from './constants.js'
import { parseWorkflowScript } from './meta.js'
import { getUserWorkflowsDir } from './paths.js'
import type { WorkflowDefinition, WorkflowSource } from './types.js'

/**
 * Every workflow runnable as a `/` command, most specific definition winning.
 *
 * Precedence, lowest to highest: bundled → plugin → personal
 * (`~/.claude/workflows`) → project, and within project the directory closest
 * to the working directory.
 * A project workflow shadowing a personal one is deliberate — it is how a repo
 * pins the version of a review its contributors run.
 */
export async function loadWorkflows(
  cwd: string = getOriginalCwd(),
): Promise<WorkflowDefinition[]> {
  const projectDirs = safeProjectDirs(cwd)

  const [plugins, personal, ...projectResults] = await Promise.all([
    loadPluginWorkflows(),
    loadWorkflowsFromDir(getUserWorkflowsDir(), 'userSettings'),
    ...projectDirs.map(dir => loadWorkflowsFromDir(dir, 'projectSettings')),
  ])

  const byName = new Map<string, WorkflowDefinition>()
  for (const workflow of getBundledWorkflows()) byName.set(workflow.name, workflow)
  // Plugin workflows are namespaced `plugin:name`, so they never collide with
  // a personal or project workflow and never need to lose a precedence fight.
  for (const workflow of plugins) byName.set(workflow.name, workflow)
  for (const workflow of personal ?? []) byName.set(workflow.name, workflow)
  // projectDirs is ordered most-specific first, so apply in reverse and let
  // the closest directory overwrite the ones above it.
  for (let i = projectResults.length - 1; i >= 0; i--) {
    for (const workflow of projectResults[i] ?? []) {
      byName.set(workflow.name, workflow)
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function findWorkflowByName(
  name: string,
  cwd?: string,
): Promise<WorkflowDefinition | undefined> {
  return (await loadWorkflows(cwd)).find(workflow => workflow.name === name)
}

/**
 * Read every `.js` workflow in one directory.
 *
 * Files are validated by parsing their `meta` literal, so a malformed script
 * is skipped with a log line rather than breaking `/` autocomplete for the
 * rest of the directory. Nothing here executes the script.
 */
export async function loadWorkflowsFromDir(
  dir: string,
  source: WorkflowSource,
  namePrefix?: string,
): Promise<WorkflowDefinition[]> {
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const loaded = await Promise.all(
    entries.map(async entry => {
      if (!entry.isFile() && !entry.isSymbolicLink()) return null
      if (!entry.name.endsWith('.js')) return null
      const filePath = join(dir, entry.name)
      try {
        const stats = await stat(filePath)
        if (stats.size > WORKFLOW_SCRIPT_MAX_BYTES) {
          logForDebugging(
            `Workflow ${filePath} exceeds ${WORKFLOW_SCRIPT_MAX_BYTES} bytes — skipping`,
          )
          return null
        }
        const script = await readFile(filePath, 'utf8')
        const parsed = parseWorkflowScript(script)
        if ('error' in parsed) {
          logForDebugging(
            `Workflow ${filePath} has invalid meta: ${parsed.error} — skipping`,
          )
          return null
        }
        return {
          source,
          name: namePrefix ? `${namePrefix}:${parsed.meta.name}` : parsed.meta.name,
          description: parsed.meta.description,
          whenToUse: parsed.meta.whenToUse,
          phases: parsed.meta.phases,
          script,
          filePath,
        } satisfies WorkflowDefinition
      } catch (error) {
        logForDebugging(
          `Workflow ${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      }
    }),
  )

  return loaded.filter((entry): entry is WorkflowDefinition => entry !== null)
}

function safeProjectDirs(cwd: string): string[] {
  try {
    return getProjectDirsUpToHome('workflows', cwd)
  } catch (error) {
    logForDebugging(
      `loadWorkflows: project-dir walk failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}
