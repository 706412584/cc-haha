import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBaseUrl } from './client'
import { sessionsApi } from './sessions'

describe('sessionsApi', () => {
  afterEach(() => {
    setBaseUrl('http://127.0.0.1:3456')
    vi.restoreAllMocks()
  })

  it('posts branch requests to the session branch endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      sessionId: 'branch-session',
      title: 'Branch',
      workDir: '/workspace/repo',
      sourceSessionId: 'source-session',
      targetMessageId: 'message-1',
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }))

    setBaseUrl('http://127.0.0.1:49237')
    const result = await sessionsApi.branch('source-session', {
      targetMessageId: 'message-1',
      title: 'Branch',
    })

    expect(result.sessionId).toBe('branch-session')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:49237/api/sessions/source-session/branch')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        targetMessageId: 'message-1',
        title: 'Branch',
      }),
    })
  })

  it('fetches a single trace call from the call detail endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      call: { id: 'call-1', sessionId: 'session-1' },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.getTraceCall('session-1', 'call-1')

    expect(result.call.id).toBe('call-1')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/trace/calls/call-1')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('reads pet activity without opening a websocket session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'thinking',
      activityState: 'waiting',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.getChatStatus('session-1')

    expect(result.state).toBe('thinking')
    expect(result.activityState).toBe('waiting')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/chat/status')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('searches the session workspace with an encoded query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      state: 'ok',
      query: 'Mental Health Controller',
      truncated: false,
      entries: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.searchWorkspace('session-1', 'Mental Health Controller')

    expect(result.query).toBe('Mental Health Controller')
    expect(result.truncated).toBe(false)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3456/api/sessions/session-1/workspace/search?query=Mental+Health+Controller')
    expect(init).toMatchObject({ method: 'GET' })
  })

  it('preserves optional local index progress from session list responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      sessions: [],
      total: 0,
      index: {
        mode: 'on',
        state: 'building',
        discovered: 12,
        indexed: 4,
        degradedSources: 0,
        databaseBytes: 4096,
        walBytes: 0,
        lastUpdatedAt: '2026-07-15T00:00:00.000Z',
        lastErrorCode: null,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await sessionsApi.list()

    expect(result.index).toMatchObject({
      mode: 'on',
      state: 'building',
      discovered: 12,
      indexed: 4,
    })
  })
})
