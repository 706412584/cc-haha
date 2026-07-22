import { describe, expect, test } from 'bun:test'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { CustomAgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { clearSessionMetadata } from './sessionStorage.js'
import {
  processResumedConversation,
  resolveResumedAgentEffortValue,
  restoreAgentFromSession,
} from './sessionRestore.js'

describe('resolveResumedAgentEffortValue', () => {
  test('restores the selected agent effort when the invocation has no CLI override', () => {
    expect(resolveResumedAgentEffortValue('medium', 'xhigh', false)).toBe(
      'xhigh',
    )
  })

  test('keeps an explicit CLI effort over the restored agent effort', () => {
    expect(resolveResumedAgentEffortValue('low', 'xhigh', true)).toBe('low')
  })

  test('keeps the initial session effort when the restored agent inherits it', () => {
    expect(resolveResumedAgentEffortValue('high', undefined, false)).toBe(
      'high',
    )
  })

  test('applies the restored agent effort to the resumed AppState', async () => {
    const restoredAgent: CustomAgentDefinition = {
      agentType: 'resume-reviewer',
      whenToUse: 'Resume deep reviews',
      rawSystemPrompt: 'Review resumed work.',
      getSystemPrompt: () => 'Review resumed work.',
      source: 'projectSettings',
      effort: 'xhigh',
    }
    const agentDefinitions = {
      activeAgents: [restoredAgent],
      allAgents: [restoredAgent],
    }

    try {
      const processed = await processResumedConversation(
        {
          messages: [],
          sessionId: undefined,
          agentSetting: restoredAgent.agentType,
        },
        { forkSession: true },
        {
          modeApi: null,
          mainThreadAgentDefinition: undefined,
          agentDefinitions,
          currentCwd: process.cwd(),
          cliAgents: [],
          initialState: {
            ...getDefaultAppState(),
            effortValue: 'medium',
          },
          hasExplicitCliEffort: false,
        },
      )

      expect(processed.restoredAgentDef).toBe(restoredAgent)
      expect(processed.initialState.agent).toBe(restoredAgent.agentType)
      expect(processed.initialState.effortValue).toBe('xhigh')
    } finally {
      restoreAgentFromSession(undefined, undefined, {
        activeAgents: [],
        allAgents: [],
      })
      clearSessionMetadata()
    }
  })
})
