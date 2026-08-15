import { parseWorkflowScript } from '../meta.js'
import type { WorkflowDefinition } from '../types.js'
import { DEEP_RESEARCH_SCRIPT } from './deepResearch.js'

const BUNDLED_SCRIPTS = [DEEP_RESEARCH_SCRIPT]

let cached: WorkflowDefinition[] | null = null

/**
 * Workflows that ship with the CLI.
 *
 * Their metadata is parsed from the same source the runtime executes, so a
 * bundled script whose `meta` drifts out of shape fails the parser here rather
 * than at run time.
 */
export function getBundledWorkflows(): WorkflowDefinition[] {
  if (cached) return cached
  const definitions: WorkflowDefinition[] = []
  for (const script of BUNDLED_SCRIPTS) {
    const parsed = parseWorkflowScript(script)
    if ('error' in parsed) {
      throw new Error(`Bundled workflow failed to parse: ${parsed.error}`)
    }
    definitions.push({
      source: 'built-in',
      name: parsed.meta.name,
      description: parsed.meta.description,
      whenToUse: parsed.meta.whenToUse,
      phases: parsed.meta.phases,
      script,
    })
  }
  cached = definitions
  return definitions
}

export function resetBundledWorkflowsForTesting(): void {
  cached = null
}
