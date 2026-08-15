export type TeamLifecycleWindow = {
  startedAt: number
  endedAt?: number
}

export type TeamLifecycleCursor = {
  active: boolean | undefined
  changedAt: number | undefined
}

export const EMPTY_TEAM_LIFECYCLE_CURSOR: TeamLifecycleCursor = {
  active: undefined,
  changedAt: undefined,
}

export function updateTeamLifecycleCursor(
  active: boolean,
  changedAt: number,
): TeamLifecycleCursor {
  return { active, changedAt }
}

/**
 * Merge transcript lifecycle boundaries with durable workbench windows.
 *
 * Either source can be truncated: compacted transcripts may omit a TeamCreate,
 * while a live transcript may not contain TeamDelete yet even though the
 * archived workbench already has an end time. The newer applicable boundary
 * wins, and a durable end closes the same lifecycle as an explicit create.
 */
export function isTeamLifecycleScopedAt(
  timestamp: number,
  cursor: TeamLifecycleCursor,
  windows: readonly TeamLifecycleWindow[] = [],
): boolean {
  const window = windows
    .filter(candidate => candidate.startedAt <= timestamp)
    .reduce<TeamLifecycleWindow | undefined>((latest, candidate) => (
      !latest || candidate.startedAt >= latest.startedAt ? candidate : latest
    ), undefined)
  const windowActive = Boolean(
    window && (window.endedAt === undefined || timestamp <= window.endedAt),
  )

  if (cursor.active === undefined || cursor.changedAt === undefined) {
    return windowActive
  }
  if (!window) return cursor.active

  // A compacted newer lifecycle overrides an older explicit delete.
  if (window.startedAt > cursor.changedAt) return windowActive

  // A durable window that contains the explicit create describes that same
  // lifecycle, so its end must still close the scope when TeamDelete is absent.
  if (
    cursor.active &&
    cursor.changedAt >= window.startedAt &&
    (window.endedAt === undefined || cursor.changedAt <= window.endedAt)
  ) {
    return windowActive
  }

  return cursor.active
}
