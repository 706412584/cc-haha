import { describe, expect, test } from 'bun:test'
import { PROMPT } from './prompt.js'

describe('TaskUpdateTool prompt', () => {
  test('describes owner and dependency update step for hybrid orchestration', () => {
    expect(PROMPT).toContain('After TaskCreate has created the full DAG')
    expect(PROMPT).toContain('use TaskUpdate to set owner, addBlocks, and addBlockedBy')
    expect(PROMPT).toContain('main, named background agents, or foreground agents')
    expect(PROMPT).toContain('Use owner `main-agent` for Main-owned tasks')
    expect(PROMPT).toContain('owner must exactly match the unique Agent name passed to launch and resume')
    expect(PROMPT).toContain('Do not assign overlapping fileScope ownership to parallel tasks')
  })
})
