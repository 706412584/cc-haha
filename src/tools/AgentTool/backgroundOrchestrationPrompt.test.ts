import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getCoordinatorSystemPrompt } from '../../coordinator/coordinatorMode.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { getPrompt } from './prompt.js'

const agentDefinitions: AgentDefinition[] = [
  {
    agentType: 'worker',
    whenToUse: 'Use for delegated work',
    tools: ['Read'],
    source: 'built-in',
  },
]

const HARD_RULE = '## Background orchestration — hard rule'
const CONTINUE_RULE =
  'continue in the same turn with the lowest-ordered or currently executable unblocked work'
const VISIBLE_PROGRESS_RULE =
  'briefly tell the user which agent is running and what you are continuing'
const OLD_COORDINATOR_RULE =
  'After launching agents, briefly tell the user what you launched and end your response'

describe('background agent orchestration guidance', () => {
  let originalApiKey: string | undefined

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
  })

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalApiKey
  })

  test('normal Agent prompt keeps background launches non-blocking', async () => {
    const prompt = await getPrompt(agentDefinitions)

    expect(prompt).toContain(HARD_RULE)
    expect(prompt).toContain(CONTINUE_RULE)
    expect(prompt).toContain(VISIBLE_PROGRESS_RULE)
    expect(prompt).toContain(
      'Do not end your turn merely because a background agent is running',
    )
    expect(prompt).toContain(
      'Use a foreground agent when you must have its result before you can proceed',
    )
    expect(prompt).toContain("read an agent's `output_file`")
    expect(prompt).toContain(
      'then actually perform that work in the same turn',
    )
    expect(prompt).toContain(
      "The release audit is running; I'm continuing the independent formatting check.",
    )
    expect(prompt).not.toContain(
      "The verification agent is running; I'm continuing the Office entry implementation.",
    )
    expect(prompt).toContain(
      'Only say that you are waiting when every remaining task depends on the background result',
    )
    expect(prompt).not.toContain(OLD_COORDINATOR_RULE)
  })

  test('normal Agent prompt requires a restrained parallel kickoff contract', async () => {
    const prompt = await getPrompt(agentDefinitions)

    expect(prompt).toContain(
      'Parallel kickoff requires at least two unblocked tasks with non-overlapping file ownership',
    )
    expect(prompt).toContain(
      'the tasks do not need each other\'s results before they can start',
    )
    expect(prompt).toContain(
      'small changes, same-file work, or chain dependencies are not a reason to fan out',
    )
    expect(prompt).toContain(
      'Launch named background agents together in one assistant message',
    )
    expect(prompt).toContain("owner='main-agent'")
    expect(prompt).toContain('owner must exactly match the unique Agent name')
    expect(prompt).toContain(
      'In that same assistant turn, the primary agent keeps the critical-path task and immediately performs its own first real non-Agent tool action',
    )
    expect(prompt).toContain('instead of waiting or merely restating the plan')
    expect(prompt).not.toContain('Parallelism is your superpower')
  })

  test('normal Agent prompt keeps implementation with the primary agent by default', async () => {
    const prompt = await getPrompt(agentDefinitions)

    expect(prompt).toContain('The primary agent owns understanding, implementation, and the decision about verification depth')
    expect(prompt).toContain('always inspect the final diff for unintended scope or leftovers')
    expect(prompt).toContain('Simple, localized, low-risk changes can otherwise stop after LSP diagnostics, type checks, or the lightest relevant static check')
    expect(prompt).toContain('Do not require a focused test after every small feature, task, file, or logical chunk')
    expect(prompt).toContain('Do not launch a verification agent unless the user explicitly requests independent verification')
    expect(prompt).toContain('A bug report, high-risk change, cross-boundary change, broad refactor, PR-ready status, file count, task count, or completed implementation is not authorization')
    expect(prompt).toContain('If the approved task or plan has no verification step, do not add one at the end')
    expect(prompt).toContain('Do not delegate simple lookups, planning, local edits, or ordinary test execution')
    expect(prompt).toContain('retain and continue at least one executable task')
    expect(prompt).not.toContain('Launch multiple agents concurrently whenever possible')
  })

  test('coordinator Agent prompt includes the shared non-blocking rule without normal ownership', async () => {
    const prompt = await getPrompt(agentDefinitions, true)

    expect(prompt).toContain(HARD_RULE)
    expect(prompt).not.toContain('The primary agent owns understanding, implementation')
    expect(prompt).toContain(CONTINUE_RULE)
    expect(prompt).toContain(VISIBLE_PROGRESS_RULE)
    expect(prompt).toContain('then actually perform that work in the same turn')
    expect(prompt).toContain(
      'Do not end your turn merely because a background agent is running',
    )
    expect(prompt).not.toContain(OLD_COORDINATOR_RULE)
  })

  test('coordinator system prompt uses dependency-driven turn completion', () => {
    const prompt = getCoordinatorSystemPrompt()

    expect(prompt).toContain(CONTINUE_RULE)
    expect(prompt).toContain(VISIBLE_PROGRESS_RULE)
    expect(prompt).toContain('then actually perform it in the same turn')
    expect(prompt).toContain(
      'Do not end your response merely because an agent is running',
    )
    expect(prompt).toContain(
      'End only when every remaining task depends on an agent result, requires user input, or is complete',
    )
    expect(prompt).toContain(
      'use foreground when you must have the result before proceeding',
    )
    expect(prompt).toContain('Default to one well-scoped worker')
    expect(prompt).toContain('Do not fan out simple research, planning, command execution, or ordinary tests')
    expect(prompt).toContain('Parallel workers require genuinely independent tasks')
    expect(prompt).toContain("read an agent's `output_file`")
    expect(prompt).not.toContain(OLD_COORDINATOR_RULE)
  })
})
