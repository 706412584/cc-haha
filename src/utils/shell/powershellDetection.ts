import { realpath, stat } from 'fs/promises'
import { win32 as pathWin32 } from 'path'
import { getPlatform } from '../platform.js'
import type { Platform } from '../platform.js'
import { which } from '../which.js'

export const POWERSHELL_PATH_OVERRIDE_ENV = 'CLAUDE_CODE_POWERSHELL_PATH'

async function probePath(p: string): Promise<string | null> {
  try {
    return (await stat(p)).isFile() ? p : null
  } catch {
    return null
  }
}

function basenameWithoutExe(candidate: string): string {
  return candidate
    .trim()
    .split(/[/\\]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')
}

export function isPowerShellExecutablePath(candidate: string): boolean {
  const basename = basenameWithoutExe(candidate)
  return basename === 'pwsh' || basename === 'powershell'
}

function hasPathSeparator(candidate: string): boolean {
  return candidate.includes('/') || candidate.includes('\\')
}

type PowerShellDetectionDeps = {
  env?: NodeJS.ProcessEnv
  getPlatform?: () => Platform
  powershellPathOverride?: string | null
  probePath?: (p: string) => Promise<string | null>
  which?: (command: string) => Promise<string | null>
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string | null {
  const systemRoot = env.SystemRoot?.trim()
    || env.SYSTEMROOT?.trim()
    || env.WINDIR?.trim()
  return systemRoot
    ? pathWin32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null
}

function windowsPwshPath(env: NodeJS.ProcessEnv): string | null {
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim()
  return programFiles
    ? pathWin32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')
    : null
}

async function resolveWindowsPowerShellFallbackPath(
  basename: 'pwsh' | 'powershell',
  deps: PowerShellDetectionDeps,
): Promise<string | null> {
  const platform = (deps.getPlatform ?? getPlatform)()
  if (platform !== 'windows') {
    return null
  }

  const pathProbe = deps.probePath ?? probePath

  const fallbackPath = basename === 'pwsh'
    ? windowsPwshPath(deps.env ?? process.env)
    : windowsPowerShellPath(deps.env ?? process.env)
  return fallbackPath ? pathProbe(fallbackPath) : null
}

export async function resolvePowerShellPathOverride(
  override: string | null | undefined = process.env[POWERSHELL_PATH_OVERRIDE_ENV],
  deps: PowerShellDetectionDeps = {},
): Promise<string | null> {
  const trimmed = override?.trim()
  if (!trimmed || !isPowerShellExecutablePath(trimmed)) {
    return null
  }

  const pathProbe = deps.probePath ?? probePath
  const basename = basenameWithoutExe(trimmed) as 'pwsh' | 'powershell'
  const platform = (deps.getPlatform ?? getPlatform)()
  if (hasPathSeparator(trimmed) || platform !== 'windows') {
    const resolvedPath = await pathProbe(trimmed)
    if (resolvedPath) {
      return resolvedPath
    }
  }

  const windowsFallback = await resolveWindowsPowerShellFallbackPath(
    basename,
    deps,
  )
  if (windowsFallback) {
    return windowsFallback
  }

  if (!hasPathSeparator(trimmed) && platform !== 'windows') {
    return (deps.which ?? which)(trimmed)
  }

  return null
}

/**
 * Attempts to find PowerShell on the system via PATH.
 * Prefers pwsh (PowerShell Core 7+), falls back to powershell (5.1).
 *
 * On Linux, if PATH resolves to a snap launcher (/snap/…) — directly or
 * via a symlink chain like /usr/bin/pwsh → /snap/bin/pwsh — probe known
 * apt/rpm install locations instead: the snap launcher can hang in
 * subprocesses while snapd initializes confinement, but the underlying
 * binary at /opt/microsoft/powershell/7/pwsh is reliable. On
 * Windows also probes known system install paths because packaged apps may
 * inherit a reduced PATH. On macOS, PATH is sufficient.
 */
export async function findPowerShell(
  deps: PowerShellDetectionDeps = {},
): Promise<string | null> {
  const overridePath = await resolvePowerShellPathOverride(
    deps.powershellPathOverride === undefined
      ? process.env[POWERSHELL_PATH_OVERRIDE_ENV]
      : deps.powershellPathOverride,
    deps,
  )
  if (overridePath) {
    return overridePath
  }

  const commandLookup = deps.which ?? which
  const platform = (deps.getPlatform ?? getPlatform)()
  if (platform === 'windows') {
    return (await resolveWindowsPowerShellFallbackPath('pwsh', deps))
      ?? resolveWindowsPowerShellFallbackPath('powershell', deps)
  }

  const pwshPath = await commandLookup('pwsh')
  if (pwshPath) {
    // Snap launcher hangs in subprocesses. Prefer the direct binary.
    // Check both the resolved PATH entry and its symlink target: on
    // some distros /usr/bin/pwsh is a symlink to /snap/bin/pwsh, which
    // would bypass a naive startsWith('/snap/') on the which() result.
    if (platform === 'linux') {
      const resolved = await realpath(pwshPath).catch(() => pwshPath)
      if (pwshPath.startsWith('/snap/') || resolved.startsWith('/snap/')) {
        const direct =
          (await probePath('/opt/microsoft/powershell/7/pwsh')) ??
          (await probePath('/usr/bin/pwsh'))
        if (direct) {
          const directResolved = await realpath(direct).catch(() => direct)
          if (
            !direct.startsWith('/snap/') &&
            !directResolved.startsWith('/snap/')
          ) {
            return direct
          }
        }
      }
    }
    return pwshPath
  }

  const powershellPath = await commandLookup('powershell')
  if (powershellPath) {
    return powershellPath
  }

  return null
}

let cachedPowerShellPath: Promise<string | null> | null = null

/**
 * Gets the cached PowerShell path. Returns a memoized promise that
 * resolves to the PowerShell executable path or null.
 */
export function getCachedPowerShellPath(): Promise<string | null> {
  if (!cachedPowerShellPath) {
    cachedPowerShellPath = findPowerShell()
  }
  return cachedPowerShellPath
}

export type PowerShellEdition = 'core' | 'desktop'

/**
 * Infers the PowerShell edition from the binary name without spawning.
 * - `pwsh` / `pwsh.exe` → 'core' (PowerShell 7+: supports `&&`, `||`, `?:`, `??`)
 * - `powershell` / `powershell.exe` → 'desktop' (Windows PowerShell 5.1:
 *   no pipeline chain operators, stderr-sets-$? bug, UTF-16 default encoding)
 *
 * PowerShell 6 (also `pwsh`, no `&&`) has been EOL since 2020 and is not
 * a realistic install target, so 'core' safely implies 7+ semantics.
 *
 * Used by the tool prompt to give version-appropriate syntax guidance so
 * the model doesn't emit `cmd1 && cmd2` on 5.1 (parser error) or avoid
 * `&&` on 7+ where it's the correct short-circuiting operator.
 */
export async function getPowerShellEdition(): Promise<PowerShellEdition | null> {
  const p = await getCachedPowerShellPath()
  if (!p) return null
  // basename without extension, case-insensitive. Covers:
  //   C:\Program Files\PowerShell\7\pwsh.exe
  //   /opt/microsoft/powershell/7/pwsh
  //   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  const base = p
    .split(/[/\\]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')
  return base === 'pwsh' ? 'core' : 'desktop'
}

/**
 * Resets the cached PowerShell path. Only for testing.
 */
export function resetPowerShellCache(): void {
  cachedPowerShellPath = null
}
