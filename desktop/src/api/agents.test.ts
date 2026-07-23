import { afterEach, describe, expect, it, vi } from 'vitest'

const apiGetMock = vi.hoisted(() => vi.fn())
const apiPostMock = vi.hoisted(() => vi.fn())
const apiPutMock = vi.hoisted(() => vi.fn())
const apiDeleteMock = vi.hoisted(() => vi.fn())

vi.mock('./client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    put: apiPutMock,
    delete: apiDeleteMock,
  },
}))

import { agentsApi, type AgentMutationInput } from './agents'

const input: AgentMutationInput = {
  scope: 'project',
  cwd: '/workspace/project one',
  name: 'code_reviewer',
  description: 'Review code',
  systemPrompt: 'Review carefully.',
  model: null,
  effort: null,
  tools: null,
  color: null,
}

describe('agentsApi', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('passes the create payload through unchanged', () => {
    agentsApi.create(input)

    expect(apiPostMock).toHaveBeenCalledWith('/api/agents', input)
  })

  it('preserves an exact nested file target when updating', () => {
    const updateInput = { ...input, target: 'nested/custom-agent-file.md' }
    agentsApi.update('reviewer/name?', updateInput)

    expect(apiPutMock).toHaveBeenCalledWith('/api/agents/reviewer%2Fname%3F', updateInput)
  })

  it('URL-encodes delete path, cwd, and exact nested file target', () => {
    agentsApi.delete(
      'reviewer/name?',
      'project',
      '/workspace/project one',
      'nested/custom agent file.md',
    )

    expect(apiDeleteMock).toHaveBeenCalledWith(
      '/api/agents/reviewer%2Fname%3F?scope=project&cwd=%2Fworkspace%2Fproject+one&target=nested%2Fcustom+agent+file.md',
    )
  })

  it('omits an empty cwd from list and delete requests', () => {
    agentsApi.list()
    agentsApi.delete('reviewer', 'user')

    expect(apiGetMock).toHaveBeenCalledWith('/api/agents')
    expect(apiDeleteMock).toHaveBeenCalledWith('/api/agents/reviewer?scope=user')
  })

  it('reloads the exact active session with the control timeout', () => {
    agentsApi.reload('session/one?')

    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/agents/reload?sessionId=session%2Fone%3F',
      undefined,
      { timeout: 120_000 },
    )
  })
})
