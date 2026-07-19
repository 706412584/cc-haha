import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectRulesSettings } from '../pages/ProjectRulesSettings'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

vi.mock('../api/client', () => ({ api: apiMock }))

describe('ProjectRulesSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        title: 'Active session',
        createdAt: '2026-07-20T00:00:00.000Z',
        modifiedAt: '2026-07-20T00:00:00.000Z',
        messageCount: 1,
        projectPath: '/workspace/demo',
        workDir: '/workspace/demo',
        workDirExists: true,
      }],
      activeSessionId: 'session-1',
    })
    apiMock.get.mockResolvedValue({
      cwd: '/workspace/demo',
      userFiles: [],
      projects: [{
        id: '-workspace-demo',
        label: '/workspace/demo',
        projectPath: '/workspace/demo',
        isCurrent: true,
        files: [{
          path: '/workspace/demo/CLAUDE.md',
          exists: true,
          type: 'project',
          label: 'CLAUDE.md',
        }],
        normalizedRules: [{
          source: 'windsurf',
          originalPath: '/workspace/demo/.windsurfrules',
          canonicalPath: 'project/global',
          fingerprint: 'abc123',
          isNative: false,
          scopes: ['project'],
          tags: ['windsurf'],
          provenance: { provider: 'Windsurf', label: '.windsurfrules' },
          status: 'conflict',
          relatedRulePaths: ['/workspace/demo/CLAUDE.md'],
        }],
      }],
    })
    apiMock.post.mockResolvedValue({ ok: true })
  })

  it('shows federated provenance and conflict state and persists all three import decisions', async () => {
    render(<ProjectRulesSettings />)

    expect(await screen.findByText('Windsurf')).toBeInTheDocument()
    expect(screen.getByText('.windsurfrules')).toBeInTheDocument()
    expect(screen.getByText('Conflict with Claude rule')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument()

    const decision = screen.getByLabelText('Import decision for .windsurfrules')
    expect(Array.from((decision as HTMLSelectElement).options).map(option => option.value)).toEqual([
      '', 'session', 'persistent', 'ignore',
    ])
    fireEvent.change(decision, { target: { value: 'persistent' } })

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/api/project-rules/decision', {
        cwd: '/workspace/demo',
        originalPath: '/workspace/demo/.windsurfrules',
        decision: 'persistent',
        sessionId: 'session-1',
      })
    })
    expect(apiMock.get).toHaveBeenCalledWith(
      '/api/project-rules?cwd=%2Fworkspace%2Fdemo&sessionId=session-1',
    )
  })
})
