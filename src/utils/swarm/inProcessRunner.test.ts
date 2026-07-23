import { describe, expect, test } from 'bun:test'
import type {
  CustomAgentDefinition,
  PluginAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { buildInProcessTeammateAgentDefinition } from './inProcessRunner.js'

describe('buildInProcessTeammateAgentDefinition', () => {
  test('preserves model and effort from the selected custom agent', () => {
    const selectedAgent: CustomAgentDefinition = {
      agentType: 'deep-reviewer',
      whenToUse: 'Review deeply',
      rawSystemPrompt: 'Review carefully',
      getSystemPrompt: () => 'Review carefully',
      source: 'projectSettings',
      tools: ['Read'],
      model: 'opus',
      effort: 'xhigh',
    }

    const resolved = buildInProcessTeammateAgentDefinition(
      'reviewer-1',
      'Team prompt',
      selectedAgent,
    )

    expect(resolved.model).toBe('opus')
    expect(resolved.effort).toBe('xhigh')
    expect(resolved.tools).toContain('Read')
    expect(resolved.tools).toContain('SendMessage')
    expect(resolved.rawSystemPrompt).toBe('Team prompt')
    expect(resolved.getSystemPrompt()).toBe('Team prompt')
  })

  test('inherits session effort when no custom agent effort is present', () => {
    const resolved = buildInProcessTeammateAgentDefinition(
      'generalist',
      'Team prompt',
    )

    expect(resolved.effort).toBeUndefined()
    expect(resolved.tools).toEqual(['*'])
  })

  test('preserves tools, model, and effort from a selected plugin Agent', () => {
    const selectedAgent: PluginAgentDefinition = {
      agentType: 'plugin-reviewer',
      whenToUse: 'Review with the plugin',
      getSystemPrompt: () => 'Apply the plugin review policy.',
      source: 'plugin',
      plugin: 'review-suite',
      tools: ['Read'],
      model: 'haiku',
      effort: 'low',
    }

    const resolved = buildInProcessTeammateAgentDefinition(
      'reviewer-2',
      selectedAgent.getSystemPrompt(),
      selectedAgent,
    )

    expect(resolved.model).toBe('haiku')
    expect(resolved.effort).toBe('low')
    expect(resolved.tools).toContain('Read')
    expect(resolved.tools).toContain('SendMessage')
    expect(resolved.rawSystemPrompt).toBe('Apply the plugin review policy.')
  })
})
