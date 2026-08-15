import { describe, expect, test } from 'bun:test'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { createWorkflowSharedCounters } from './harness.js'
import { executeWorkflowScript, prepareWorkflowScript } from './runtime.js'
import type {
  WorkflowAgentRunParams,
  WorkflowAgentRunResult,
} from './runWorkflowAgent.js'
import type { WorkflowProgressEvent } from './types.js'

const CHILD = [
  "export const meta = { name: 'child', description: 'Child run' }",
  "const out = await agent('child-' + (args ?? 'none'))",
  'return { child: out }',
].join('\n')

async function runParent(
  parentBody: string,
  options: { childScript?: string } = {},
) {
  const parent = prepareWorkflowScript(
    `export const meta = { name: 'parent', description: 'Parent run' }\n${parentBody}`,
  )
  if (!parent.ok) throw new Error(parent.error)

  const events: WorkflowProgressEvent[] = []
  const shared = createWorkflowSharedCounters()
  let seq = 0
  const runAgentImpl = async (
    params: WorkflowAgentRunParams,
  ): Promise<WorkflowAgentRunResult> => ({
    agentId: `a${++seq}`,
    value: `ran:${params.prompt}`,
    tokens: 1,
    toolCalls: 0,
  })
  const toolUseContext = {
    abortController: new AbortController(),
    options: { mainLoopModel: 'test-model' },
  } as unknown as ToolUseContext
  const canUseTool = (() => {}) as unknown as CanUseToolFn

  const outcome = await executeWorkflowScript({
    vmScript: parent.vmScript,
    toolUseContext,
    canUseTool,
    runId: 'wf_nested00-abc',
    shared,
    onProgress: event => events.push(event),
    onAgentController: () => {},
    runAgentImpl,
    runNestedWorkflow: async (_nameOrRef, args) => {
      const child = prepareWorkflowScript(options.childScript ?? CHILD)
      if (!child.ok) throw new Error(child.error)
      const result = await executeWorkflowScript({
        vmScript: child.vmScript,
        toolUseContext,
        canUseTool,
        runId: 'wf_nested00-abc',
        args,
        shared,
        onProgress: event => events.push(event),
        onAgentController: () => {},
        runAgentImpl,
        runNestedWorkflow: undefined,
      })
      if (result.error) throw new Error(result.error)
      return result.result
    },
  })

  return { outcome, events, shared }
}

describe('nested workflow()', () => {
  test('returns the child result and passes args through', async () => {
    const { outcome } = await runParent(
      "const child = await workflow('child', 'from-parent')\nreturn child",
    )
    expect(outcome.error).toBeUndefined()
    expect(outcome.result).toEqual({ child: 'ran:child-from-parent' })
  })

  test('parent and child agents share one index sequence', async () => {
    const { outcome, events, shared } = await runParent(
      [
        "const a = await agent('parent-1')",
        "const child = await workflow('child', 'x')",
        "const b = await agent('parent-2')",
        'return [a, child, b]',
      ].join('\n'),
    )
    expect(outcome.error).toBeUndefined()

    const indexes = [
      ...new Set(
        events
          .filter(event => event.type === 'workflow_agent')
          .map(event => event.index),
      ),
    ].sort((a, b) => a - b)
    // Three agents in total across both scripts, no index reused — a reused
    // index would overwrite the parent's row in the progress view.
    expect(indexes).toEqual([1, 2, 3])
    expect(shared.getAgentCount()).toBe(3)
  })

  test("the child's failure surfaces as the parent's failure", async () => {
    const { outcome } = await runParent(
      "return await workflow('child')",
      { childScript: "export const meta = { name: 'child', description: 'Boom' }\nthrow new Error('child exploded')\n" },
    )
    expect(outcome.error).toContain('child exploded')
  })

  test('workflow() is unavailable when the runner is not supplied', async () => {
    const prepared = prepareWorkflowScript(
      "export const meta = { name: 'p', description: 'p' }\nreturn await workflow('child')\n",
    )
    if (!prepared.ok) throw new Error(prepared.error)
    const outcome = await executeWorkflowScript({
      vmScript: prepared.vmScript,
      toolUseContext: {
        abortController: new AbortController(),
        options: { mainLoopModel: 'test-model' },
      } as unknown as ToolUseContext,
      canUseTool: (() => {}) as unknown as CanUseToolFn,
      runId: 'wf_nested00-abc',
      onAgentController: () => {},
    })
    expect(outcome.error).toBe('workflow() is not available in this run')
  })
})
