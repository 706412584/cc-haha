import { readFile } from 'fs/promises'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { findWorkflowByName } from '../../utils/workflows/discovery.js'
import type { WorkflowSharedCounters } from '../../utils/workflows/harness.js'
import type { WorkflowJournal } from '../../utils/workflows/journal.js'
import {
  executeWorkflowScript,
  prepareWorkflowScript,
} from '../../utils/workflows/runtime.js'
import type {
  WorkflowProgressEvent,
  WorkflowTokenBudget,
} from '../../utils/workflows/types.js'

export type NestedWorkflowDeps = {
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  runId: string
  tokenBudget?: WorkflowTokenBudget
  journal?: WorkflowJournal
  shared: WorkflowSharedCounters
  onProgress: (event: WorkflowProgressEvent) => void
  onAgentController: (
    agentKey: string,
    controller: AbortController | undefined,
  ) => void
}

/**
 * Build the `workflow(nameOrRef, args)` global.
 *
 * A child runs inside the parent's run: same run id, same journal, same
 * concurrency pool and agent-index sequence (so its progress rows sit
 * alongside the parent's instead of overwriting them), and the same token
 * budget. Nesting is one level — a child's own `workflow()` throws, which is
 * what keeps the agent cap meaningful.
 */
export function createNestedWorkflowRunner(
  deps: NestedWorkflowDeps,
): (nameOrRef: unknown, args: unknown) => Promise<unknown> {
  return async (nameOrRef, args) => {
    const script = await resolveNestedScript(nameOrRef)
    const prepared = prepareWorkflowScript(script)
    if (!prepared.ok) {
      throw new Error(`workflow(): ${prepared.error}`)
    }

    deps.onProgress({
      type: 'workflow_log',
      message: `workflow(${prepared.meta.name}) started`,
    })

    const outcome = await executeWorkflowScript({
      vmScript: prepared.vmScript,
      toolUseContext: deps.toolUseContext,
      canUseTool: deps.canUseTool,
      runId: deps.runId,
      args,
      seedPhaseTitles: prepared.meta.phases?.map(phase => phase.title),
      tokenBudget: deps.tokenBudget,
      journal: deps.journal,
      onProgress: deps.onProgress,
      onAgentController: deps.onAgentController,
      shared: deps.shared,
      // One level only: the child gets no `workflow()` of its own.
      runNestedWorkflow: undefined,
    })

    if (outcome.error) {
      throw new Error(`workflow(${prepared.meta.name}): ${outcome.error}`)
    }
    return outcome.result
  }
}

async function resolveNestedScript(nameOrRef: unknown): Promise<string> {
  if (typeof nameOrRef === 'string') {
    const workflow = await findWorkflowByName(nameOrRef)
    if (!workflow) throw new Error(`workflow(): unknown workflow '${nameOrRef}'`)
    return workflow.script
  }
  if (nameOrRef !== null && typeof nameOrRef === 'object') {
    const scriptPath = (nameOrRef as { scriptPath?: unknown }).scriptPath
    if (typeof scriptPath === 'string') {
      try {
        return await readFile(scriptPath, 'utf8')
      } catch (error) {
        throw new Error(
          `workflow(): failed to read ${scriptPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
  throw new Error(
    "workflow() expects a saved workflow name or { scriptPath: '...' }",
  )
}
