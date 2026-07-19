import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_CREATION_SYSTEM_PROMPT } from '../../components/agents/generateAgent.js'
import {
  getSessionSpecificGuidanceSection,
  getVerificationAgentSessionGuidance,
} from '../../constants/prompts.js'
import { AGENT_TOOL_NAME } from './constants.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

function loadSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

describe('verification agent triggering guidance', () => {
  test('Agent tool examples do not delegate tests solely because code was written', () => {
    const source = loadSource('src/tools/AgentTool/prompt.ts')

    expect(source).not.toContain('Since a significant piece of code was written')
    expect(source).not.toContain('run focused checks directly before using the test-runner agent')
    expect(source).toContain('use the independent test-runner the user requested as the final verification pass')
    expect(source).toContain('high-risk cross-boundary change')
  })

  test('generated agent examples require independent verification value', () => {
    expect(AGENT_CREATION_SYSTEM_PROMPT).not.toContain('after a logical chunk of code is written')
    expect(AGENT_CREATION_SYSTEM_PROMPT).not.toContain('Since a significant piece of code was written')
    expect(AGENT_CREATION_SYSTEM_PROMPT).toContain('only when the user explicitly requests independent verification')
    expect(AGENT_CREATION_SYSTEM_PROMPT).toContain('one final independent pass after the implementation scope is stable')
    expect(AGENT_CREATION_SYSTEM_PROMPT).not.toContain('after direct focused verification')
  })

  test('session guidance makes the main agent responsible for direct checks', () => {
    const guidance = getVerificationAgentSessionGuidance(true) ?? ''

    expect(guidance).toContain('You own the decision about whether verification is needed and how deep it should be')
    expect(guidance).toContain('Always inspect the final diff for unintended scope or leftovers')
    expect(guidance).toContain('simple, localized, low-risk changes can stop after LSP diagnostics, type checks, or the lightest relevant static check')
    expect(guidance).toContain('Do not require a focused test after every small feature, task, file, or logical chunk')
    expect(guidance).toContain('Do not launch a verification agent unless the user explicitly requests independent verification')
    expect(guidance).toContain('A bug report alone is not such a request')
    expect(guidance).toContain('If the approved task or plan has no verification step, do not add one at the end')
    expect(guidance).toContain('Do not invoke verification solely because code was written')
    expect(guidance).not.toContain('Non-trivial means: 3+ file edits')
    expect(getVerificationAgentSessionGuidance(false)).toBeNull()
    expect(getSessionSpecificGuidanceSection(new Set([AGENT_TOOL_NAME]), [])).not.toBeNull()
  })
})
