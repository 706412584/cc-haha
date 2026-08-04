import { getInitialSettings } from '../settings/settings.js'
import {
  getShellToolAvailability,
  resolveAvailableShellTool,
  type ShellToolAvailability,
  type ShellToolType,
} from './shellToolUtils.js'

export type { ShellToolType } from './shellToolUtils.js'

/**
 * Resolve the default shell for input-box `!` commands.
 *
 * Prefer settings.defaultShell (or Bash when unset), then fall back to the
 * other shell only when the preferred executable is unavailable. This keeps
 * the historical Bash default while allowing Windows installations without
 * Git Bash to use native PowerShell.
 */
export function resolveDefaultShellFromAvailability(
  configuredShell: ShellToolType | undefined,
  availability: ShellToolAvailability,
): ShellToolType | null {
  return resolveAvailableShellTool({
    preferredShell: configuredShell ?? 'bash',
    availability,
  })
}

export function resolveDefaultShell(): ShellToolType | null {
  return resolveDefaultShellFromAvailability(
    getInitialSettings().defaultShell,
    getShellToolAvailability(),
  )
}
