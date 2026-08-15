import { readFile } from 'fs/promises'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { generateTaskId } from '../../Task.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import { hasAcceptedWorkflowsInAutoMode } from '../../utils/workflows/autoModeConsent.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { findWorkflowByName, loadWorkflows } from '../../utils/workflows/discovery.js'
import {
  areWorkflowsEnabled,
  describeWorkflowsDisabled,
  getWorkflowsDisabledReason,
} from '../../utils/workflows/enabled.js'
import { WORKFLOW_SCRIPT_MAX_BYTES } from '../../utils/workflows/constants.js'
import { createWorkflowRunId } from '../../utils/workflows/paths.js'
import { prepareWorkflowScript } from '../../utils/workflows/runtime.js'
import { launchWorkflow } from './launchWorkflow.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { getWorkflowToolPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    script: z
      .string()
      .max(WORKFLOW_SCRIPT_MAX_BYTES)
      .optional()
      .describe(
        'Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` ' +
          '(pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().',
      ),
    scriptPath: z
      .string()
      .optional()
      .describe(
        'Path to a workflow script file on disk. Every Workflow invocation persists its script under the ' +
          'session directory and returns the path in the tool result. Takes precedence over `script` and `name`.',
      ),
    name: z
      .string()
      .optional()
      .describe(
        'Name of a predefined workflow (built-in or from .claude/workflows/).',
      ),
    args: z
      .unknown()
      .optional()
      .describe(
        'Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as ' +
          'actual JSON values, NOT as a JSON-encoded string.',
      ),
    title: z.string().optional().describe('Ignored — set the title in `meta`.'),
    description: z
      .string()
      .optional()
      .describe('Ignored — set the description in `meta`.'),
    resumeFromRunId: z
      .string()
      .regex(/^wf_[a-z0-9-]{6,}$/)
      .optional()
      .describe(
        'Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged ' +
          '(prompt, opts) return their cached results instantly; only edited or new calls re-run.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// Mirrors the official WorkflowOutput in @anthropic-ai/claude-code's
// sdk-tools.d.ts. Optional fields are optional there too, so a transcript
// written before a field existed still replays without re-validation failing.
const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['async_launched', 'remote_launched']),
    taskId: z.string(),
    taskType: z.enum(['local_workflow', 'remote_agent']).optional(),
    workflowName: z.string().optional(),
    runId: z.string().optional(),
    summary: z.string().optional(),
    transcriptDir: z.string().optional(),
    scriptPath: z.string().optional(),
    sessionUrl: z.string().optional(),
    warning: z.string().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'orchestrate many subagents from a script',
  maxResultSizeChars: 100_000,
  userFacingName: () => 'Workflow',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return areWorkflowsEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isOpenWorld() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.script ?? input.scriptPath ?? input.name ?? ''
  },
  /**
   * A run spawns many agents whose file edits are auto-approved, so the launch
   * itself is the only place the user gets to say no. `bypassPermissions` and
   * non-interactive runs have nobody to ask; everywhere else prompts unless the
   * user has allow-listed this workflow name.
   */
  async checkPermissions(input, context) {
    const appState = context?.getAppState()
    const permissionContext = appState?.toolPermissionContext
    if (
      permissionContext?.mode === 'bypassPermissions' ||
      context?.options.isNonInteractiveSession
    ) {
      return { behavior: 'allow', updatedInput: input }
    }
    // Ultracode is a standing instruction to orchestrate every task; prompting
    // per run would mean prompting every turn.
    if (appState?.ultracode === true) {
      return { behavior: 'allow', updatedInput: input }
    }
    // Auto mode asks once per machine, then remembers.
    if (permissionContext?.mode === 'auto' && hasAcceptedWorkflowsInAutoMode()) {
      return { behavior: 'allow', updatedInput: input }
    }

    const ruleContent = typeof input.name === 'string' ? input.name : undefined
    if (ruleContent && permissionContext) {
      const denied = getRuleByContentsForTool(
        permissionContext,
        WorkflowTool,
        'deny',
      ).get(ruleContent)
      if (denied) {
        return {
          behavior: 'deny',
          message: `${WORKFLOW_TOOL_NAME} denied for workflow "${ruleContent}".`,
          decisionReason: { type: 'rule', rule: denied },
        }
      }
      const allowed = getRuleByContentsForTool(
        permissionContext,
        WorkflowTool,
        'allow',
      ).get(ruleContent)
      if (allowed) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'rule', rule: allowed },
        }
      }
    }

    return {
      behavior: 'ask',
      message:
        'Claude wants to run a dynamic workflow, which can spawn many subagents and use a large number of tokens.',
      ...(ruleContent
        ? {
            suggestions: [
              {
                type: 'addRules' as const,
                rules: [{ toolName: WORKFLOW_TOOL_NAME, ruleContent }],
                behavior: 'allow' as const,
                destination: 'localSettings' as const,
              },
            ],
          }
        : {}),
    }
  },
  async description(input) {
    if (input.name) return `Run the ${input.name} workflow`
    return 'Run a dynamic workflow'
  },
  async prompt() {
    return getWorkflowToolPrompt()
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
    }
  },
  async call(input, toolUseContext, canUseTool) {
    const disabled = getWorkflowsDisabledReason()
    if (disabled) throw new Error(describeWorkflowsDisabled(disabled))

    const resolved = await resolveScript(input)
    if ('error' in resolved) throw new Error(resolved.error)

    const prepared = prepareWorkflowScript(resolved.script)
    if (!prepared.ok) throw new Error(prepared.error)

    const workflowRunId = input.resumeFromRunId ?? createWorkflowRunId()
    const taskId = generateTaskId('local_workflow')

    const launched = launchWorkflow({
      taskId,
      workflowRunId,
      script: resolved.script,
      scriptPath: resolved.scriptPath,
      args: input.args,
      meta: prepared.meta,
      vmScript: prepared.vmScript,
      toolUseContext,
      canUseTool,
      toolUseId: toolUseContext.toolUseId,
      isResume: input.resumeFromRunId !== undefined,
    })

    return {
      data: {
        status: 'async_launched' as const,
        taskId,
        taskType: 'local_workflow' as const,
        workflowName: prepared.meta.name,
        runId: workflowRunId,
        summary: prepared.meta.description,
        transcriptDir: launched.transcriptDir,
        scriptPath: launched.scriptPath,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * Work out which script this call should run.
 *
 * `scriptPath` wins so an edited run can be relaunched byte-for-byte, then a
 * saved `name`, then an inline `script`. Resolving by name here (rather than
 * making the model paste the script back) is what lets `/deep-research` and
 * saved workflows be one-line calls.
 */
export async function resolveScriptForTesting(input: {
  script?: string
  scriptPath?: string
  name?: string
}): Promise<{ script: string; scriptPath?: string } | { error: string }> {
  return resolveScript(input)
}

async function resolveScript(input: {
  script?: string
  scriptPath?: string
  name?: string
}): Promise<{ script: string; scriptPath?: string } | { error: string }> {
  if (input.scriptPath) {
    try {
      const script = await readFile(input.scriptPath, 'utf8')
      return { script, scriptPath: input.scriptPath }
    } catch (error) {
      return {
        error: `Failed to read workflow script file ${input.scriptPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }

  if (input.name) {
    const workflow = await findWorkflowByName(input.name)
    if (!workflow) {
      const available = (await loadWorkflows())
        .map(entry => entry.name)
        .join(', ')
      return {
        error: `Unknown workflow '${input.name}'.${available ? ` Available: ${available}` : ''}`,
      }
    }
    // Deliberately no scriptPath: the run gets its own session copy. Pointing
    // it at the saved workflow would make the run write back over the user's
    // file, and would resume from whatever that file says later rather than
    // from what actually ran.
    return { script: workflow.script }
  }

  if (input.script) return { script: input.script }

  return {
    error: 'Workflow requires one of `script`, `scriptPath`, or `name`.',
  }
}
