import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import memoize from 'lodash-es/memoize.js'
import * as pathWin32 from 'path/win32'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { memoizeWithLRU } from './memoize.js'
import { getPlatform } from './platform.js'

function checkPathExists(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

export function resolveTrustedWherePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const systemRoot = env.SystemRoot?.trim()
    || env.SYSTEMROOT?.trim()
    || env.WINDIR?.trim()
  return systemRoot ? pathWin32.join(systemRoot, 'System32', 'where.exe') : null
}

type FindExecutablesDeps = {
  cwd?: string
  defaultLocations?: readonly string[]
  env?: NodeJS.ProcessEnv
  exists?: (candidate: string) => boolean
  realpath?: (candidate: string) => string
  runWhere?: (wherePath: string, executable: string) => string
  wherePath?: string | null
}

/** Find every trusted executable candidate reported by Windows. */
export function findExecutables(
  executable: string,
  deps: FindExecutablesDeps = {},
): string[] {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? checkPathExists
  const realpath = deps.realpath ?? realpathSync.native
  const defaultLocations = deps.defaultLocations ?? (executable === 'git'
    ? [
        env.ProgramFiles,
        env.PROGRAMFILES,
        env['ProgramFiles(x86)'],
        env['PROGRAMFILES(X86)'],
      ]
        .map(value => value?.trim())
        .filter((value): value is string => Boolean(value))
        .map(programFiles => pathWin32.join(programFiles, 'Git', 'cmd', 'git.exe'))
    : [])
  const wherePath = deps.wherePath === undefined
    ? resolveTrustedWherePath(env)
    : deps.wherePath
  const runWhere = deps.runWhere ?? ((trustedWherePath, command) =>
    execFileSync(trustedWherePath, [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    }))

  let whereCandidates: string[] = []
  if (wherePath && exists(wherePath)) {
    try {
      whereCandidates = runWhere(wherePath, executable)
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
    } catch {
      // Keep trusted default locations when PATH lookup fails.
    }
  }

  const cwd = realpath(deps.cwd ?? getCwd()).toLowerCase()
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const candidatePath of [...defaultLocations.filter(exists), ...whereCandidates]) {
    let canonicalPath: string
    try {
      canonicalPath = realpath(candidatePath)
    } catch {
      continue
    }
    const normalizedPath = canonicalPath.toLowerCase()
    const pathDir = pathWin32.dirname(normalizedPath).toLowerCase()
    if (pathDir === cwd || normalizedPath.startsWith(cwd + '\\')) {
      logForDebugging(
        `Skipping potentially malicious executable in current directory: ${candidatePath}`,
      )
      continue
    }
    if (seen.has(normalizedPath)) continue
    seen.add(normalizedPath)
    candidates.push(canonicalPath)
  }
  return candidates
}

/**
 * If Windows, set the SHELL environment variable to git-bash path.
 * This is used by BashTool and Shell.ts for user shell commands.
 * COMSPEC is left unchanged for system process execution.
 */
export function setShellIfWindows(): void {
  if (getPlatform() === 'windows') {
    const gitBashPath = tryFindGitBashPath()
    if (!gitBashPath) {
      logForDebugging(
        'Git Bash not found on Windows; leaving SHELL unset for lazy fallback handling',
        { level: 'warn' },
      )
      return
    }
    process.env.SHELL = gitBashPath
    logForDebugging(`Using bash path: "${gitBashPath}"`)
  }
}

function gitInstallRoot(gitExecutable: string): string | null {
  const normalized = gitExecutable.replaceAll('/', '\\')
  for (const suffix of [
    '\\cmd\\git.exe',
    '\\mingw64\\bin\\git.exe',
    '\\mingw32\\bin\\git.exe',
    '\\usr\\bin\\git.exe',
    '\\bin\\git.exe',
  ]) {
    if (normalized.toLowerCase().endsWith(suffix)) {
      return normalized.slice(0, -suffix.length)
    }
  }
  return null
}

export function resolveGitBashPathFromGitExecutables(
  gitExecutables: readonly string[],
  exists: (candidate: string) => boolean = checkPathExists,
  realpath: (candidate: string) => string = realpathSync.native,
): string | null {
  for (const gitExecutable of gitExecutables) {
    let installRoot: string | null
    try {
      installRoot = gitInstallRoot(realpath(gitExecutable))
    } catch {
      continue
    }
    if (!installRoot) continue

    const normalizedRoot = installRoot.toLowerCase() + '\\'
    for (const relativeBashPath of [
      ['bin', 'bash.exe'],
      ['usr', 'bin', 'bash.exe'],
    ]) {
      const candidate = pathWin32.join(installRoot, ...relativeBashPath)
      if (!exists(candidate)) continue
      try {
        const canonicalBash = realpath(candidate)
        if (canonicalBash.toLowerCase().startsWith(normalizedRoot)) {
          return canonicalBash
        }
      } catch {
        continue
      }
    }
  }
  return null
}

/**
 * Best-effort Git Bash resolution on Windows.
 *
 * Returns null when Git Bash is unavailable so callers can decide whether to
 * fall back (for example, to PowerShell) instead of hard-exiting the process.
 */
export const tryFindGitBashPath = memoize((): string | null => {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    if (checkPathExists(process.env.CLAUDE_CODE_GIT_BASH_PATH)) {
      return process.env.CLAUDE_CODE_GIT_BASH_PATH
    }
    return null
  }

  return resolveGitBashPathFromGitExecutables(findExecutables('git'))
})

/**
 * Find the path where `bash.exe` included with git-bash exists, exiting the process if not found.
 */
export const findGitBashPath = memoize((): string => {
  const gitBashPath = tryFindGitBashPath()
  if (gitBashPath) {
    return gitBashPath
  }

  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH path "${process.env.CLAUDE_CODE_GIT_BASH_PATH}"`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(
    'Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe',
  )
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
})

/** Convert a Windows path to a POSIX path using pure JS. */
export const windowsPathToPosixPath = memoizeWithLRU(
  (windowsPath: string): string => {
    // Handle UNC paths: \\server\share -> //server/share
    if (windowsPath.startsWith('\\\\')) {
      return windowsPath.replace(/\\/g, '/')
    }
    // Handle drive letter paths: C:\Users\foo -> /c/Users/foo
    const match = windowsPath.match(/^([A-Za-z]):[/\\]/)
    if (match) {
      const driveLetter = match[1]!.toLowerCase()
      return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
    }
    // Already POSIX or relative — just flip slashes
    return windowsPath.replace(/\\/g, '/')
  },
  (p: string) => p,
  500,
)

/** Convert a POSIX path to a Windows path using pure JS. */
export const posixPathToWindowsPath = memoizeWithLRU(
  (posixPath: string): string => {
    // Handle UNC paths: //server/share -> \\server\share
    if (posixPath.startsWith('//')) {
      return posixPath.replace(/\//g, '\\')
    }
    // Handle /cygdrive/c/... format
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Handle /c/... format (MSYS2/Git Bash)
    const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/)
    if (driveMatch) {
      const driveLetter = driveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(2)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // Already Windows or relative — just flip slashes
    return posixPath.replace(/\//g, '\\')
  },
  (p: string) => p,
  500,
)
