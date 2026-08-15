import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import * as localAgentTask from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import * as agentToolUtils from './agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import {
  resumeAgentBackground,
  resolveResumedAgentModelOverride,
  resolveResumedAgentOwnerAgentId,
} from './resumeAgent.js'
import * as runAgentModule from './runAgent.js'

afterEach(() => {
  mock.restore()
})

describe('resumed Agent model override', () => {
  test('retains a valid per-invocation model alias', () => {
    expect(resolveResumedAgentModelOverride('fable')).toBe('fable')
    expect(resolveResumedAgentModelOverride('haiku')).toBe('haiku')
  })

  test('keeps old or malformed metadata from injecting a model', () => {
    expect(resolveResumedAgentModelOverride(undefined)).toBeUndefined()
    expect(resolveResumedAgentModelOverride('provider-owned-model')).toBeUndefined()
    expect(resolveResumedAgentModelOverride(7)).toBeUndefined()
  })
})

describe('resumed Agent ownership', () => {
  test('uses the nearest live owner before restored lifecycle metadata', () => {
    expect(resolveResumedAgentOwnerAgentId(
      'current-parent',
      'in-memory-parent',
      { ownerAgentId: 'persisted-parent' },
    )).toBe('current-parent')
    expect(resolveResumedAgentOwnerAgentId(
      undefined,
      'in-memory-parent',
      { ownerAgentId: 'persisted-parent' },
    )).toBe('in-memory-parent')
    expect(resolveResumedAgentOwnerAgentId(
      undefined,
      undefined,
      { ownerAgentId: 'persisted-parent' },
    )).toBe('persisted-parent')
    expect(resolveResumedAgentOwnerAgentId(undefined, undefined, null)).toBeUndefined()
  })

  test('threads the current parent through restored registration and execution', async () => {
    const agentId = 'resumed-agent-run'
    const appState = {
      ...getDefaultAppState(),
      tasks: {
        [agentId]: {
          type: 'local_agent',
          toolUseId: 'toolu_original_agent',
          ownerAgentId: 'in-memory-parent',
        },
      },
      agentDefinitions: {
        activeAgents: [GENERAL_PURPOSE_AGENT],
        allAgents: [GENERAL_PURPOSE_AGENT],
      },
    }
    const toolUseContext = {
      options: {
        mainLoopModel: 'sonnet',
        tools: [],
        mcpClients: [],
        agentDefinitions: appState.agentDefinitions,
      },
      getAppState: () => appState,
      setAppState: () => {},
      messages: [],
      agentId: 'current-parent',
      toolUseId: 'toolu_send_message',
    } as unknown as ToolUseContext
    spyOn(sessionStorage, 'getAgentTranscript').mockResolvedValue({
      messages: [],
      contentReplacements: [],
    })
    spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({
      agentType: GENERAL_PURPOSE_AGENT.agentType,
      ownerAgentId: 'persisted-parent',
      description: 'Original description',
      toolUseId: 'toolu_original_agent',
    })
    const taskAbortController = new AbortController()
    const registerSpy = spyOn(localAgentTask, 'registerAsyncAgent').mockReturnValue({
      agentId,
      abortController: taskAbortController,
    } as never)
    let lifecycleParams: Parameters<typeof agentToolUtils.runAsyncAgentLifecycle>[0] | undefined
    const lifecycleSpy = spyOn(agentToolUtils, 'runAsyncAgentLifecycle').mockImplementation(
      async params => {
        lifecycleParams = params
      },
    )
    const runAgentSpy = spyOn(runAgentModule, 'runAgent').mockImplementation(
      (async function* () {}) as typeof runAgentModule.runAgent,
    )

    const result = await resumeAgentBackground({
      agentId,
      prompt: 'Continue verification',
      toolUseContext,
      canUseTool: (async () => ({ behavior: 'allow' })) as never,
    })

    expect(result).toMatchObject({
      agentId,
      description: 'Original description',
    })
    expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: 'toolu_original_agent',
      ownerAgentId: 'current-parent',
    }))
    expect(lifecycleSpy).toHaveBeenCalledWith(expect.objectContaining({
      taskId: agentId,
      parentToolUseId: 'toolu_original_agent',
      ownerAgentId: 'current-parent',
    }))

    lifecycleParams?.makeStream(() => {})
    expect(runAgentSpy).toHaveBeenCalledWith(expect.objectContaining({
      spawningToolUseId: 'toolu_original_agent',
      ownerAgentId: 'current-parent',
      streamTargetAgentId: agentId,
    }))
  })
})
