import { describe, expect, test } from 'bun:test'
import { getEnterPlanModeToolPrompt } from './prompt.js'

describe('EnterPlanModeTool prompt', () => {
  test('asks complex implementation plans to include a task DAG for hybrid orchestration', () => {
    const prompt = getEnterPlanModeToolPrompt()

    expect(prompt).toContain('For complex implementation plans')
    expect(prompt).toContain('Task DAG')
    expect(prompt).toContain('file ownership')
    expect(prompt).toContain('waves')
    expect(prompt).toContain('main/background/foreground execution')
    expect(prompt).toContain('verification for each task')
  })
})
