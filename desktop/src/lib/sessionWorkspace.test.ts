import { describe, expect, it } from 'vitest'
import { getSessionBrowsablePath, getSessionWorkspaceState } from './sessionWorkspace'

describe('session workspace state', () => {
  it('keeps legacy missing sessions classified as missing', () => {
    const session = {
      workDir: '/repo/deleted',
      projectRoot: '/repo/deleted',
      workDirExists: false,
    }

    expect(getSessionWorkspaceState(session)).toBe('missing')
    expect(getSessionBrowsablePath(session)).toBeUndefined()
  })

  it('uses the original project as a safe browse target for cleaned worktrees', () => {
    const session = {
      workDir: '/repo/.claude/worktrees/desktop-main-12345678',
      projectRoot: '/repo',
      workDirExists: false,
      workspaceState: 'worktree_removed' as const,
    }

    expect(getSessionWorkspaceState(session)).toBe('worktree_removed')
    expect(getSessionBrowsablePath(session)).toBe('/repo')
  })
})
