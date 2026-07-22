import { afterEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({
  api: {
    get: apiGetMock,
  },
}))

import { subagentsApi } from './subagents'

describe('subagentsApi', () => {
  afterEach(() => {
    apiGetMock.mockReset()
  })

  it('URL-encodes session and tool ids when fetching a run', () => {
    apiGetMock.mockResolvedValue({ ok: true })

    subagentsApi.getRunByTool('session/one two?x=1', 'tool/alpha beta?y=2')

    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/sessions/session%2Fone%20two%3Fx%3D1/subagents/by-tool/tool%2Falpha%20beta%3Fy%3D2',
    )
  })

  it('includes the live task id when fetching a running SubAgent', () => {
    apiGetMock.mockResolvedValue({ ok: true })

    subagentsApi.getRunByTool('session-1', 'tool-1', 'agent-one_2')

    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/sessions/session-1/subagents/by-tool/tool-1?taskId=agent-one_2',
    )
  })
})
