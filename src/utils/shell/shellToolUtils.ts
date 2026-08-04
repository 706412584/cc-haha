import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'
import { tryFindGitBashPath } from '../windowsPaths.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

export type ShellToolType = 'bash' | 'powershell'
export type ShellToolAvailability = { bash: boolean; powershell: boolean }

export function resolveShellToolAvailability({
  platform,
  gitBashPath,
  userType,
  powerShellSetting,
}: {
  platform: ReturnType<typeof getPlatform>
  gitBashPath: string | null
  userType: string | undefined
  powerShellSetting: string | undefined
}): ShellToolAvailability {
  if (platform !== 'windows') {
    return { bash: true, powershell: false }
  }

  const bash = gitBashPath !== null
  const powershell = isEnvDefinedFalsy(powerShellSetting)
    ? false
    : userType === 'ant' || !bash || isEnvTruthy(powerShellSetting)

  return { bash, powershell }
}

export function resolveAvailableShellTool({
  preferredShell,
  availability,
  allowFallback = true,
}: {
  preferredShell: ShellToolType
  availability: ShellToolAvailability
  allowFallback?: boolean
}): ShellToolType | null {
  if (availability[preferredShell]) {
    return preferredShell
  }

  if (!allowFallback) {
    return null
  }

  const fallback = preferredShell === 'bash' ? 'powershell' : 'bash'
  return availability[fallback] ? fallback : null
}

export function getShellToolAvailability(): ShellToolAvailability {
  const platform = getPlatform()
  return resolveShellToolAvailability({
    platform,
    gitBashPath: platform === 'windows' ? tryFindGitBashPath() : null,
    userType: process.env.USER_TYPE,
    powerShellSetting: process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL,
  })
}

/** Windows exposes Bash only when a real Git Bash installation is available. */
export function isBashToolEnabled(): boolean {
  return getShellToolAvailability().bash
}

/**
 * Runtime gate for PowerShellTool. On Windows it remains opt-in for external
 * users with Git Bash, but becomes the default fallback when Git Bash is
 * unavailable. An explicit env=0 always opts out.
 */
export function isPowerShellToolEnabled(): boolean {
  return getShellToolAvailability().powershell
}
