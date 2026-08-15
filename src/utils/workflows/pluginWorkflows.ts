import { stat } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from '../debug.js'
import { loadAllPluginsCacheOnly } from '../plugins/pluginLoader.js'
import { loadWorkflowsFromDir } from './discovery.js'
import type { WorkflowDefinition } from './types.js'

/**
 * Dynamic workflows shipped by enabled plugins.
 *
 * Names are namespaced `plugin:workflow` — two plugins can both ship a
 * `release-audit` and neither has to lose. Reads the plugin cache rather than
 * re-scanning: this runs on every `/` autocomplete.
 */
export async function loadPluginWorkflows(): Promise<WorkflowDefinition[]> {
  let plugins: Awaited<ReturnType<typeof loadAllPluginsCacheOnly>>['plugins']
  try {
    plugins = (await loadAllPluginsCacheOnly()).plugins ?? []
  } catch (error) {
    logForDebugging(
      `loadPluginWorkflows: plugin cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }

  const found: WorkflowDefinition[] = []
  for (const plugin of plugins) {
    if (plugin.enabled === false) continue
    const dirs = [
      ...(plugin.workflowsPath ? [plugin.workflowsPath] : []),
      ...(plugin.workflowsPaths ?? []),
    ]
    for (const path of dirs) {
      const dir = await resolveDirectory(path)
      if (!dir) continue
      found.push(
        ...(await loadWorkflowsFromDir(dir, 'plugin', plugin.manifest.name)),
      )
    }
  }
  return found
}

/** A manifest entry may point at a single `.js` file rather than a directory. */
async function resolveDirectory(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).isDirectory() ? path : dirname(path)
  } catch {
    return undefined
  }
}
