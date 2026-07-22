import type {
  LspDiagnostic,
  LegacyWorkspaceLspState,
  WorkspaceLspState,
} from '../types/lsp'

/**
 * Map the server-side {@link WorkspaceLspState} (one shape, four states
 * including `idle`) onto the legacy four-state shape that
 * {@link LspStatusIndicator} consumes.
 *
 * Preserve the server's typed unavailable reason so the indicator can
 * distinguish unsupported files, missing prerequisites, and retryable
 * lifecycle failures without inferring state from an error string.
 */
export function toLegacyLspState(
  state: WorkspaceLspState | undefined,
  errorCount: number,
  workspaceId: string,
): LegacyWorkspaceLspState {
  // No state yet (loading, or never queried) — present as `starting` so the
  // pill spins instead of flashing "unavailable".
  if (!state || state.state === 'idle' || state.state === 'starting') {
    return { state: 'starting', workspaceId, errorCount: 0 }
  }
  if (state.state === 'ready') {
    return { state: 'ready', workspaceId, errorCount }
  }
  return {
    state: 'unavailable',
    workspaceId,
    reason: state.reason,
    errorCount: 0,
    ...(state.error ? { lastStderrTail: state.error } : {}),
  }
}

/** Count how many diagnostics in a list are errors (not warnings/info/hints). */
export function errorCountFromDiagnostics(
  diagnostics: readonly LspDiagnostic[] | undefined,
): number {
  if (!diagnostics || diagnostics.length === 0) return 0
  let count = 0
  for (const d of diagnostics) {
    if (d.severity === 'error') count += 1
  }
  return count
}
