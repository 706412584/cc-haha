import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Command } from '../../types/command.js'
import { loadWorkflows } from '../../utils/workflows/discovery.js'
import { areWorkflowsEnabled } from '../../utils/workflows/enabled.js'
import type { WorkflowDefinition } from '../../utils/workflows/types.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

/**
 * Turn every discovered workflow into a `/<name>` command.
 *
 * The command is a prompt, not a direct tool call: whatever the user typed
 * after the name has to become the `args` value, and only the model can decide
 * whether "issues 1024, 1025" is a list of numbers or a sentence. The prompt
 * pins everything else so the model's only job is that conversion.
 */
export async function getWorkflowCommands(cwd?: string): Promise<Command[]> {
  if (!areWorkflowsEnabled()) return []
  const workflows = await loadWorkflows(cwd)
  return workflows.map(workflow => createWorkflowCommand(workflow))
}

export function createWorkflowCommand(workflow: WorkflowDefinition): Command {
  return {
    type: 'prompt',
    name: workflow.name,
    description: workflow.description,
    progressMessage: `running the ${workflow.name} workflow`,
    contentLength: workflow.description.length + 200,
    argNames: ['args'],
    source: workflowCommandSource(workflow),
    isEnabled: () => areWorkflowsEnabled(),
    userFacingName: () => workflow.name,
    async getPromptForCommand(args: string): Promise<ContentBlockParam[]> {
      const argsLine =
        args.trim() === ''
          ? 'Pass no `args`.'
          : `Convert the following invocation text into the \`args\` value and pass it: ${JSON.stringify(args.trim())}. ` +
            'If it is a list of items, pass a real JSON array, not a string.'
      return [
        {
          type: 'text',
          text:
            `Run the saved workflow "${workflow.name}" by calling ${WORKFLOW_TOOL_NAME} exactly once with ` +
            `{ name: "${workflow.name}" }. ${argsLine}\n` +
            'Do not write a new script and do not do the work yourself — the saved workflow already ' +
            'contains the orchestration. After the tool returns, end your turn; the result arrives as a ' +
            'task notification.',
        },
      ]
    },
  } as Command
}

function workflowCommandSource(
  workflow: WorkflowDefinition,
): 'builtin' | 'userSettings' | 'projectSettings' | 'plugin' {
  switch (workflow.source) {
    case 'built-in':
      return 'builtin'
    case 'plugin':
      return 'plugin'
    case 'projectSettings':
      return 'projectSettings'
    default:
      return 'userSettings'
  }
}
