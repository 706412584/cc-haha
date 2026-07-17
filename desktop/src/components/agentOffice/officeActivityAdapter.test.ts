import { describe, expect, it } from 'vitest'
import type { SessionActivitySnapshot } from '../activity/useSessionActivityModel'
import { buildSessionActivityModel } from '../activity/sessionActivityModel'
import {
  adaptActivityToOfficeRoster,
  type OfficeActivityCopy,
} from './officeActivityAdapter'
import { formatOfficeAgentNameplate } from './types/agent'

const ENGLISH_COPY: OfficeActivityCopy = {
  sectionRoles: {
    team: 'Team member',
    subagents: 'Engineering specialist',
    backgroundTasks: 'Operations specialist',
    tasks: 'Project specialist',
  },
  mainAgentName: 'Main Agent',
  mainAgentRole: 'Lead',
  working: 'Working',
}

function adapt(activity: SessionActivitySnapshot) {
  return adaptActivityToOfficeRoster(activity, ENGLISH_COPY)
}

function snapshot(overrides: Partial<SessionActivitySnapshot> = {}): SessionActivitySnapshot {
  return {
    isMemberSession: false,
    mainAgent: {
      status: 'tool_executing',
      operationalStatus: 'foreground',
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
    const agents = adapt(snapshot())

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
    const agents = adapt(snapshot({
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
      'Lead',
      'Team member',
      'Engineering specialist',
      'Operations specialist',
      'Project specialist',
    ])
    expect(agents[0]?.name).toBe('Main Agent')
    expect(formatOfficeAgentNameplate(agents[0]!)).toBe('Lead\nMain Agent')
    expect(formatOfficeAgentNameplate(agents[2]!)).toBe('Engineering specialist\nImplement fe…')
  })

  it('ignores completed history when choosing live office seats', () => {
    const agents = adapt(snapshot({
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

  it('uses locale-resolved copy instead of leaking Simplified Chinese', () => {
    const agents = adapt(snapshot({
      mainAgent: {
        status: 'tool_executing',
        operationalStatus: 'foreground',
        activeToolName: null,
        statusVerb: '',
      },
    }))

    expect(agents[0]).toMatchObject({
      name: 'Main Agent',
      role: 'Lead',
      currentTask: 'Working',
    })
    expect(agents.slice(0, 4).map((agent) => agent.role)).toEqual([
      'Lead',
      'Team member',
      'Engineering specialist',
      'Project specialist',
    ])
    expect(agents.map((agent) => agent.role).join(' ')).not.toMatch(/[团队研发运维项目老板]/)
  })

  it('clips long live labels for desk readability without splitting Unicode characters', () => {
    const agents = adapt(snapshot({
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

  it.each([
    { label: '12345678901👨‍👩‍👧‍👦x', expected: '12345678901👨‍👩‍👧‍👦…' },
    { label: '12345678901e\u0301x', expected: '12345678901e\u0301…' },
    { label: '12345678901🇺🇳x', expected: '12345678901🇺🇳…' },
  ])('clips complete grapheme clusters in $label', ({ label, expected }) => {
    const agents = adapt(snapshot({
      model: buildSessionActivityModel({
        sessionId: 'session-1',
        tasks: [{
          id: 'grapheme-task',
          subject: label,
          description: '',
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

    expect(agents[1]?.name).toBe(expected)
  })

  it('marks real pending work and idle team members as available for ambient behavior', () => {
    const agents = adapt(snapshot({
      mainAgent: { status: 'idle', operationalStatus: 'idle', activeToolName: null, statusVerb: '' },
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
      role: 'Team member',
      state: 'idle',
      ambientEligible: true,
      sourceKey: 'team:waiting-designer',
    })

    const pendingAgents = adapt(snapshot({
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
    const agents = adapt(snapshot({
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

  it('shows idle Main as working while supervising a running Agent', () => {
    const agents = adapt(snapshot({
      mainAgent: { status: 'idle', operationalStatus: 'supervising', activeToolName: null, statusVerb: '' },
    }))

    expect(agents[0]).toMatchObject({ state: 'working', currentTask: 'Working' })
  })

  it('shows ready or blocked Main tasks as thinking without inventing active execution', () => {
    const agents = adapt(snapshot({
      mainAgent: { status: 'idle', operationalStatus: 'ready', activeToolName: null, statusVerb: '' },
    }))

    expect(agents[0]).toMatchObject({ state: 'thinking', currentTask: 'Working' })
  })

  it('keeps unused seats idle instead of inventing work', () => {
    const agents = adapt(snapshot({
      mainAgent: { status: 'idle', operationalStatus: 'idle', activeToolName: null, statusVerb: '' },
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
