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

  test('requires the primary agent to continue ready main-owned work in the same turn', () => {
    expect(PROMPT).toContain('After resolving, call TaskList to find your next task')
    expect(PROMPT).toContain(
      'If an unblocked pending task is owned by `main-agent`, start the lowest-ID one and execute a real tool action in the same turn',
    )
    expect(PROMPT).toContain(
      'Do not end with only a progress update, task announcement, or promise to continue',
    )
  })
})
