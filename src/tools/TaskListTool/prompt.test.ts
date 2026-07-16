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
})
