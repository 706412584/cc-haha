import { describe, expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'

describe('TaskListTool prompt', () => {
  test('requires confirming wave 1 before parallel kickoff', () => {
    const prompt = getPrompt()

    expect(prompt).toContain('Before launching parallel agents for approved complex work')
    expect(prompt).toContain('call TaskList to confirm Wave 1')
    expect(prompt).toContain('pending, unblocked')
    expect(prompt).toContain('non-overlapping file scopes')
  })

  test('treats unblocked main-agent tasks as immediately executable work', () => {
    const prompt = getPrompt()

    expect(prompt).toContain(
      'pending tasks owned by `main-agent` are available to the primary agent when blockedBy is empty',
    )
    expect(prompt).toContain(
      'do not stop after merely reporting or restating the next task',
    )
    expect(prompt).toContain(
      'claim or mark the lowest-ID executable task in_progress and perform a real tool action in the same turn',
    )
  })
})
