import { describe, expect, test } from 'bun:test'
import { getPrompt } from './prompt.js'

describe('TaskCreateTool prompt', () => {
  test('describes complex-plan DAG creation and orchestration metadata', () => {
    const prompt = getPrompt()

    expect(prompt).toContain('For complex approved plans, create the full Task DAG before starting work')
    expect(prompt).toContain('Create all tasks first with TaskCreate')
    expect(prompt).toContain('metadata.orchestration')
    expect(prompt).toContain('schemaVersion: 1')
    expect(prompt).toContain("execution: 'main' | 'background-agent' | 'foreground-agent'")
    expect(prompt).toContain('fileScope: repo-relative paths owned by that task')
    expect(prompt).toContain('wave: positive integer')
    expect(prompt).toContain('verification: focused proof required for that task')
  })
})
