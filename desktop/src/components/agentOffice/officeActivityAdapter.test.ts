import { describe, expect, it } from 'vitest'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import { buildSessionActivityModel } from '../activity/sessionActivityModel'
import { adaptActivityToOfficeRoster } from './officeActivityAdapter'
import { formatOfficeAgentNameplate } from './types/agent'

function snapshot(overrides: Partial<SessionActivitySnapshot> = {}): SessionActivitySnapshot {
  return {
    isMemberSession: false,
    mainAgent: {
      status: 'tool_executing',
      activeToolName: 'Agent',
      statusVerb: 'Delegating',
    },
    model: buildSessionActivityModel({
      sessionId: 'session-1',
      tasks: [{
        id: 'task-1',
        subject: 'Integrate original office',
        description: '',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        taskListId: 'session-1',
      }],
      completedAndDismissed: false,
      backgroundTasks: [{
        taskId: 'bg-1',
        toolUseId: 'tool-bg',
        status: 'running',
        description: 'Inspect Spine assets',
        taskType: 'local_agent',
        startedAt: 1000,
        updatedAt: 2000,
      }],
      agentNotifications: [],
      teamMembers: [
        {
          agentId: 'designer',
          role: 'Designer',
          status: 'running',
          currentTask: 'Animate handoff',
        },
      ],
    }),
    ...overrides,
  }
}

describe('adaptActivityToOfficeRoster', () => {
  it('maps the main Agent and real activity rows onto the original six desks', () => {
    const agents = adaptActivityToOfficeRoster(snapshot())

    expect(agents).toHaveLength(6)
    expect(agents[0]).toMatchObject({
      id: 'main-agent',
      name: 'Main Agent',
      state: 'working',
      currentTask: 'Delegating',
      sourceKey: 'main-agent',
    })
    expect(agents[1]).toMatchObject({
      name: 'Designer',
      state: 'working',
      currentTask: 'Animate handoff',
      sourceKey: 'team:designer',
    })
    expect(agents[2]).toMatchObject({
      state: 'working',
      currentTask: undefined,
      sourceKey: 'subagents:tool-bg',
    })
    expect(agents[3]).toMatchObject({
      state: 'working',
      currentTask: undefined,
      sourceKey: 'tasks:task-1',
    })
  })

  it('assigns stable job titles from real activity semantics', () => {
    const agents = adaptActivityToOfficeRoster(snapshot({
      model: buildSessionActivityModel({
        sessionId: 'session-1',
        tasks: [{
          id: 'task-1',
          subject: 'Ship release',
          description: '',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
          taskListId: 'session-1',
        }],
        completedAndDismissed: false,
        backgroundTasks: [
          {
            taskId: 'subagent-1',
            toolUseId: 'tool-subagent',
            status: 'running',
            description: 'Implement feature',
            taskType: 'local_agent',
            startedAt: 1000,
            updatedAt: 2000,
          },
          {
            taskId: 'background-1',
            toolUseId: 'tool-background',
            status: 'running',
            description: 'Monitor build',
            taskType: 'shell',
            startedAt: 1000,
            updatedAt: 2000,
          },
        ],
        agentNotifications: [],
        teamMembers: [{
          agentId: 'designer',
          role: 'Designer',
          status: 'running',
          currentTask: 'Polish office',
        }],
      }),
    }))

    expect(agents.slice(0, 5).map((agent) => agent.role)).toEqual([
      '老板',
      '团队成员',
      '研发专员',
      '运维专员',
      '项目专员',
    ])
    expect(agents[0]?.name).toBe('Main Agent')
    expect(formatOfficeAgentNameplate(agents[0]!)).toBe('老板\nMain Agent')
    expect(formatOfficeAgentNameplate(agents[2]!)).toBe('研发专员\nImplement fe…')
  })

  it('ignores completed history when choosing live office seats', () => {
    const agents = adaptActivityToOfficeRoster(snapshot({
      model: buildSessionActivityModel({
        sessionId: 'session-1',
        tasks: [
          {
            id: 'old-task',
            subject: 'Old completed task',
            description: '',
            status: 'completed',
            blocks: [],
            blockedBy: [],
            taskListId: 'session-1',
          },
          {
            id: 'live-task',
            subject: 'Current task',
            description: '',
            status: 'in_progress',
            blocks: [],
            blockedBy: [],
            taskListId: 'session-1',
          },
        ],
        completedAndDismissed: false,
        backgroundTasks: [],
        agentNotifications: [],
      }),
    }))

    expect(agents[1]).toMatchObject({
      name: 'Current task',
      sourceKey: 'tasks:live-task',
    })
    expect(agents.some((agent) => agent.name === 'Old completed task')).toBe(false)
  })

  it('clips long live labels for desk readability without splitting Unicode characters', () => {
    const agents = adaptActivityToOfficeRoster(snapshot({
      model: buildSessionActivityModel({
        sessionId: 'session-1',
        tasks: [{
          id: 'long-task',
          subject: '审查真实活动映射与实时状态恢复',
          description: '确认真实 Agent 状态不会被场景动画生命周期覆盖',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
          taskListId: 'session-1',
        }],
        completedAndDismissed: false,
        backgroundTasks: [],
        agentNotifications: [],
      }),
    }))

    expect(agents[1]).toMatchObject({
      name: '审查真实活动映射与实时状…',
      currentTask: '确认真实 Agent 状态不会被场景…',
    })
  })

  it('marks real pending work and idle team members as available for ambient behavior', () => {
    const agents = adaptActivityToOfficeRoster(snapshot({
      mainAgent: { status: 'idle', activeToolName: null, statusVerb: '' },
      model: buildSessionActivityModel({
        sessionId: 'session-1',
        tasks: [],
        completedAndDismissed: false,
        backgroundTasks: [],
        agentNotifications: [],
        teamMembers: [{
          agentId: 'waiting-designer',
          role: 'Designer',
          status: 'idle',
        }],
      }),
    }))

    expect(agents[1]).toMatchObject({
      name: 'Designer',
      role: '团队成员',
      state: 'idle',
      ambientEligible: true,
      sourceKey: 'team:waiting-designer',
    })

    const pendingAgents = adaptActivityToOfficeRoster(snapshot({
      model: buildSessionActivityModel({
        sessionId: 'session-1',
        tasks: [{
          id: 'waiting-task',
          subject: 'Wait for dependency',
          description: '',
          status: 'pending',
          blocks: [],
          blockedBy: ['other-task'],
          taskListId: 'session-1',
        }],
        completedAndDismissed: false,
        backgroundTasks: [],
        agentNotifications: [],
      }),
    }))

    expect(pendingAgents[1]).toMatchObject({
      state: 'thinking',
      ambientEligible: true,
      sourceKey: 'tasks:waiting-task',
    })
  })

  it('fills seats with active work before real idle team members', () => {
    const agents = adaptActivityToOfficeRoster(snapshot({
      model: buildSessionActivityModel({
        sessionId: 'session-1',
        tasks: [{
          id: 'active-task',
          subject: 'Active project',
          description: '',
          status: 'in_progress',
          blocks: [],
          blockedBy: [],
          taskListId: 'session-1',
        }],
        completedAndDismissed: false,
        backgroundTasks: [],
        agentNotifications: [],
        teamMembers: Array.from({ length: 5 }, (_, index) => ({
          agentId: `idle-${index}`,
          role: `Idle ${index}`,
          status: 'idle' as const,
        })),
      }),
    }))

    expect(agents.some((agent) => agent.sourceKey === 'tasks:active-task')).toBe(true)
    expect(agents.filter((agent) => agent.sourceKey?.startsWith('team:idle-'))).toHaveLength(4)
  })

  it('keeps unused seats idle instead of inventing work', () => {
    const agents = adaptActivityToOfficeRoster(snapshot({
      mainAgent: { status: 'idle', activeToolName: null, statusVerb: '' },
      model: buildSessionActivityModel({
        sessionId: 'session-1',
        tasks: [],
        completedAndDismissed: false,
        backgroundTasks: [],
        agentNotifications: [],
      }),
    }))

    expect(agents[0]).toMatchObject({ state: 'idle', currentTask: undefined })
    expect(agents.slice(1).every((agent) => agent.state === 'idle')).toBe(true)
    expect(agents.slice(1).every((agent) => agent.sourceKey === undefined)).toBe(true)
  })
})
