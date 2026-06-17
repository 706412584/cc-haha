import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'

const apiPostMock = vi.fn()

vi.mock('./client', () => ({
  api: {
    post: (url: string, body?: unknown) => apiPostMock(url, body),
    get: vi.fn(),
  },
}))

import { projectsApi } from './projects'

beforeEach(() => {
  apiPostMock.mockReset()
})

describe('projectsApi.clearSessions', () => {
  it('posts to /api/projects/sessions/clear with workDir in body', async () => {
    apiPostMock.mockResolvedValue({ ok: true, deletedSessions: 3, projectDirRemoved: true })

    const result = await projectsApi.clearSessions('/work/alpha')

    expect(apiPostMock).toHaveBeenCalledTimes(1)
    expect(apiPostMock).toHaveBeenCalledWith('/api/projects/sessions/clear', { workDir: '/work/alpha' })
    expect(result.deletedSessions).toBe(3)
    expect(result.projectDirRemoved).toBe(true)
  })

  it('propagates server errors so the caller can show a toast', async () => {
    apiPostMock.mockRejectedValue(new Error('Forbidden'))
    await expect(projectsApi.clearSessions('/work/beta')).rejects.toThrow('Forbidden')
  })
})
