import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeMemberTranscriptDelta, useTeamStore } from './teamStore'
import { useChatStore } from './chatStore'
import type { UIMessage } from '../types/chat'

const { getMemberTranscriptMock } = vi.hoisted(() => ({
  getMemberTranscriptMock: vi.fn(),
}))

vi.mock('../api/teams', () => ({
  teamsApi: {
    getMemberTranscript: getMemberTranscriptMock,
    list: vi.fn(),
    get: vi.fn(),
    sendMemberMessage: vi.fn(),
    delete: vi.fn(),
  },
}))

function userMessage(id: string, content: string, timestamp: number, pending = false): UIMessage {
  return {
    id,
    type: 'user_text',
    content,
    timestamp,
    ...(pending ? { pending: true } : {}),
  }
}

describe('teamStore incremental transcript polling', () => {
  beforeEach(() => {
    getMemberTranscriptMock.mockReset()
    useTeamStore.getState().clearTeam()
    useChatStore.setState({ sessions: {} })
  })

  afterEach(() => {
    useTeamStore.getState().stopMemberPolling()
    useTeamStore.getState().clearTeam()
  })

  it('appends unseen messages once and removes a matching pending echo', () => {
    const pending = userMessage('pending-1', 'please review', 1_000, true)
    const existing = [userMessage('durable-1', 'old', 500), pending]
    const delta = [
      userMessage('server-1', 'please review', 1_100),
      userMessage('server-1', 'please review', 1_100),
    ]

    const merged = mergeMemberTranscriptDelta(existing, delta)

    expect(merged.map(message => message.id)).toEqual(['durable-1', 'server-1'])
  })

  it('ignores a stale transcript response that resolves after a newer poll', async () => {
    let resolveOld: (value: unknown) => void = () => {}
    getMemberTranscriptMock
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({
        messages: [{
          id: 'new-message',
          type: 'user',
          content: 'new',
          timestamp: '2026-01-01T00:00:02.000Z',
        }],
        signature: 'new-signature',
        cursor: 'new-cursor',
        afterOrdinal: 1,
      })
    useTeamStore.setState({
      activeTeam: {
        name: 'team-1',
        members: [{
          agentId: 'agent-1',
          role: 'worker',
          status: 'running',
        }],
      },
    })
    const sessionId = 'team-member:agent-1'

    const oldPoll = useTeamStore.getState().refreshMemberSession(sessionId)
    await useTeamStore.getState().refreshMemberSession(sessionId)
    resolveOld({
      messages: [{
        id: 'old-message',
        type: 'user',
        content: 'old',
        timestamp: '2026-01-01T00:00:01.000Z',
      }],
      signature: 'old-signature',
      cursor: 'old-cursor',
      afterOrdinal: 0,
    })
    await oldPoll

    const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
    expect(messages.map(message => message.id)).toEqual(['new-message'])
  })

  it('replaces a cursor-backed transcript when a legacy sidecar omits cursor metadata', async () => {
    const fullSnapshot = {
      messages: [
        {
          id: 'deleted-message',
          type: 'user',
          content: 'removed by the legacy full snapshot',
          timestamp: '2026-01-01T00:00:01.000Z',
        },
        {
          id: 'kept-message',
          type: 'user',
          content: 'still present',
          timestamp: '2026-01-01T00:00:02.000Z',
        },
      ],
      signature: 'cursor-signature',
      cursor: 'cursor-token',
      afterOrdinal: 1,
    }
    const legacySnapshot = {
      messages: [{
        id: 'kept-message',
        type: 'user',
        content: 'still present',
        timestamp: '2026-01-01T00:00:02.000Z',
      }],
    }
    getMemberTranscriptMock
      .mockResolvedValueOnce(fullSnapshot)
      .mockResolvedValueOnce(legacySnapshot)
      .mockResolvedValueOnce(legacySnapshot)
    useTeamStore.setState({
      activeTeam: {
        name: 'team-legacy',
        members: [{
          agentId: 'agent-legacy',
          role: 'worker',
          status: 'running',
        }],
      },
    })
    const sessionId = 'team-member:agent-legacy'

    await useTeamStore.getState().refreshMemberSession(sessionId)
    await useTeamStore.getState().refreshMemberSession(sessionId)

    expect(getMemberTranscriptMock.mock.calls[1]?.[2]).toMatchObject({
      signature: 'cursor-signature',
      cursor: 'cursor-token',
      afterOrdinal: 1,
    })
    expect(
      useChatStore.getState().sessions[sessionId]?.messages.map(message => message.id),
    ).toEqual(['kept-message'])

    await useTeamStore.getState().refreshMemberSession(sessionId)
    expect(getMemberTranscriptMock.mock.calls[2]?.[2]).toEqual({})
  })
})
