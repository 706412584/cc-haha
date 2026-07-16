import type { SessionListItem, SessionWorkspaceState } from '../types/session'

type SessionWorkspaceFields = Pick<
  SessionListItem,
  'workDirExists' | 'workspaceState' | 'workDir' | 'projectRoot'
>

export function getSessionWorkspaceState(
  session: SessionWorkspaceFields | null | undefined,
): SessionWorkspaceState {
  if (!session) return 'available'
  return session.workspaceState ?? (session.workDirExists ? 'available' : 'missing')
}

export function getSessionBrowsablePath(
  session: SessionWorkspaceFields | null | undefined,
): string | undefined {
  if (!session) return undefined
  const state = getSessionWorkspaceState(session)
  if (state === 'available') return session.workDir ?? session.projectRoot ?? undefined
  if (state === 'worktree_removed') return session.projectRoot ?? undefined
  return undefined
}
