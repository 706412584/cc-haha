import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runWithTeammateContext, type TeammateContext } from './teammateContext.js'
import { getTaskListId } from './tasks.js'

// The real context API rather than a module stub: stubbing the module drops
// its other exports and breaks every importer of it.
const TEAMMATE: TeammateContext = {
  agentId: 'researcher@review-crew',
  agentName: 'researcher',
  teamName: 'review-crew',
  planModeRequired: false,
  parentSessionId: 'leader-session',
  isInProcessTeammate: true,
}

describe('getTaskListId', () => {
  const originalTaskList = process.env.CLAUDE_CODE_TASK_LIST_ID

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_TASK_LIST_ID
  })

  afterEach(() => {
    if (originalTaskList === undefined) {
      delete process.env.CLAUDE_CODE_TASK_LIST_ID
    } else {
      process.env.CLAUDE_CODE_TASK_LIST_ID = originalTaskList
    }
  })

  test('a subagent keeps its own list instead of writing the session list', () => {
    // The bug this guards: a subagent runs in-process, so without agent
    // scoping every task it created landed in the parent session's list and
    // rendered in the UI as if the assistant had planned it. The agent keeps
    // its tracking — it just no longer shares the session's.
    expect(getTaskListId('a7e7846c7975c3665')).toBe('a7e7846c7975c3665')
    expect(getTaskListId('a7e7846c7975c3665')).not.toBe(getTaskListId())
  })

  test('two subagents never share a list', () => {
    // Twenty parallel workflow agents on one list is also a write race.
    expect(getTaskListId('agent-one')).not.toBe(getTaskListId('agent-two'))
  })

  test('the session keeps a stable list of its own', () => {
    expect(getTaskListId()).toBe(getTaskListId())
    expect(getTaskListId()).toBeTruthy()
  })

  test('an explicit task list id still wins over the agent', () => {
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'explicit-list'
    expect(getTaskListId('some-agent')).toBe('explicit-list')
  })

  test('a teammate keeps sharing the leader list — that is the point of a team', () => {
    runWithTeammateContext(TEAMMATE, () => {
      expect(getTaskListId('teammate-agent')).toBe('review-crew')
    })
  })

  test('keeps a teammate on the canonical Team list despite a standalone override', () => {
    runWithTeammateContext({ ...TEAMMATE, teamName: 'My_Team' }, () => {
      expect(getTaskListId('teammate-agent')).toBe('my-team')
      process.env.CLAUDE_CODE_TASK_LIST_ID = 'explicit-team-list'
      expect(getTaskListId('teammate-agent')).toBe('my-team')
    })
  })
})
