import { execFile } from 'child_process'
import { realpath, stat } from 'fs/promises'
import { win32 as pathWin32 } from 'path'
import { getPlatform } from '../platform.js'
import type { Platform } from '../platform.js'
import { which } from '../which.js'

export const POWERSHELL_PATH_OVERRIDE_ENV = 'CLAUDE_CODE_POWERSHELL_PATH'
/**
 * The conventional Windows PowerShell 5.1 path.
 *
 * When the caller supplies an explicit environment (including an empty one) and
 * it names no system root, return null: the fork must not guess a fixed
 * `C:\Windows` path the caller's world does not describe. Only when no
 * environment is supplied — the production default, `process.env` — do we fall
 * back to the conventional `C:\Windows` root, which is what a packaged Windows
 * sidecar assumes even when a stripped process env omits SystemRoot.
 */
function windowsPowerShellSystemPath(
  env: NodeJS.ProcessEnv | undefined,
): string | null {
  const source = env ?? process.env
  const systemRoot = source.SystemRoot?.trim()
    || source.SYSTEMROOT?.trim()
    || source.WINDIR?.trim()
  const root = systemRoot ?? (env === undefined ? 'C:\\Windows' : undefined)
  return root
    ? pathWin32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null
}

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

async function readWindowsPwshHome(): Promise<string | null> {
  return new Promise(resolve => {
    execFile(
      'cmd.exe',
      ['/C', 'pwsh', '-NoProfile', '-Command', '$PSHOME'],
      {
        maxBuffer: 8192,
        timeout: 3000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const trimmed = stdout.toString().trim()
        resolve(trimmed || null)
      },
    )
  })
}

type PowerShellDetectionDeps = {
  env?: NodeJS.ProcessEnv
  getPlatform?: () => Platform
  powershellPathOverride?: string | null
  probePath?: (p: string) => Promise<string | null>
  readWindowsPwshHome?: () => Promise<string | null>
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

  if (basename === 'pwsh') {
    // PowerShell Core may be invokable via Windows shell/app aliases while
    // absent from the sidecar PATH. Ask pwsh where it actually lives.
    const psHome = await (deps.readWindowsPwshHome ?? readWindowsPwshHome)()
    if (psHome) {
      const resolvedFromHome = await pathProbe(
        pathWin32.join(psHome, 'pwsh.exe'),
      )
      if (resolvedFromHome) {
        return resolvedFromHome
      }
    }
  }

  // Fork: derive the install location from the environment rather than
  // guessing a hard-coded default. A packaged app can run with an unusual
  // ProgramFiles/SystemRoot, and probing `C:\Program Files\...` when the
  // environment doesn't point there can return a false positive. When the
  // environment names no such directory, there is nothing trustworthy to
  // probe and we return null (the caller falls back to `which`).
  const fallbackPath = basename === 'pwsh'
    ? windowsPwshPath(deps.env ?? process.env)
    : windowsPowerShellSystemPath(deps.env)
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
 * binary at /opt/microsoft/powershell/7/pwsh is reliable. Windows also
 * checks the standard install locations when the sidecar PATH omits them.
 */
export async function findPowerShell(deps: PowerShellDetectionDeps = {}): Promise<string | null> {
  const overridePath = await resolvePowerShellPathOverride(
    deps.powershellPathOverride === undefined
      ? process.env[POWERSHELL_PATH_OVERRIDE_ENV]
      : deps.powershellPathOverride,
    deps,
  )
  if (overridePath) {
    return overridePath
  }

  const lookup = deps.which ?? which
  const probe = deps.probePath ?? probePath
  const platform = (deps.getPlatform ?? getPlatform)()
  // Fork: probe the environment-derived Windows install location (ProgramFiles
  // and the pwsh-home probe) before giving up; this covers the sidecar
  // PATH-omission case while honoring user-custom install locations. When the
  // environment names no such directory, there is nothing trustworthy to probe.
  const pwshPath = await lookup('pwsh') ??
    (platform === 'windows' ? await resolveWindowsPowerShellFallbackPath('pwsh', deps) : null)
  if (pwshPath) {
    // Snap launcher hangs in subprocesses. Prefer the direct binary.
    // Check both the resolved PATH entry and its symlink target: on
    // some distros /usr/bin/pwsh is a symlink to /snap/bin/pwsh, which
    // would bypass a naive startsWith('/snap/') on the which() result.
    if (platform === 'linux') {
      const resolved = await realpath(pwshPath).catch(() => pwshPath)
      if (pwshPath.startsWith('/snap/') || resolved.startsWith('/snap/')) {
        const direct =
          (await probe('/opt/microsoft/powershell/7/pwsh')) ??
          (await probe('/usr/bin/pwsh'))
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

  return await lookup('powershell') ??
    (platform === 'windows' ? await resolveWindowsPowerShellFallbackPath('powershell', deps) : null)
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
