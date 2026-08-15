import { describe, expect, mock, test } from 'bun:test'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../../Tool.js'

const capturedOwners: Array<string | undefined> = []
const capturedSources: Array<string | undefined> = []
const runAgentMock = mock((params: { ownerAgentId?: string; querySource?: string }) => {
  capturedOwners.push(params.ownerAgentId)
  capturedSources.push(params.querySource)
  return (async function* () {})()
})
const runAgentModule = await import('../../tools/AgentTool/runAgent.js')

mock.module('../../tools/AgentTool/runAgent.js', () => ({
  // LocalAgentTask pulls in AgentSummary and AgentTool while assembling the
  // worker tool pool. Preserve every sibling export so this test replaces only
  // the worker entry point instead of silently changing that module contract.
  ...runAgentModule,
  runAgent: runAgentMock,
}))

const { runWorkflowAgent } = await import('./runWorkflowAgent.js')

function context(ownerAgentId?: string): ToolUseContext {
  return {
    agentId: ownerAgentId as ToolUseContext['agentId'],
    abortController: new AbortController(),
    options: {
      tools: [],
      mainLoopModel: 'test-model',
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { tools: [] },
    }),
  } as unknown as ToolUseContext
}

async function invoke(ownerAgentId?: string): Promise<void> {
  await runWorkflowAgent({
    prompt: 'Inspect the workflow owner',
    toolUseContext: context(ownerAgentId),
    canUseTool: (() => {}) as unknown as CanUseToolFn,
    runId: 'wf_owner00-abc',
    ownerAgentId,
    abortController: new AbortController(),
    onAgentId: () => {},
    onProgress: () => {},
  })
}

describe('runWorkflowAgent ownership', () => {
  test('persists nested ownership without adding an owner to root workers', async () => {
    capturedOwners.length = 0
    capturedSources.length = 0

    await invoke('parent-agent')
    await invoke()

    expect(capturedOwners).toEqual(['parent-agent', undefined])
    expect(capturedSources).toEqual(['workflow_agent', 'workflow_agent'])
  })
})
