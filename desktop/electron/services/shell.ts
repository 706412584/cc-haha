import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const ALLOWED_SYSTEM_SETTINGS_URLS = new Set([
  'ms-settings:notifications',
  'x-apple.systempreferences:com.apple.preference.notifications',
])
const ALLOWED_SYSTEM_FILE_EXTENSIONS = new Set([
  '.7z',
  '.aac',
  '.avif',
  '.avi',
  '.bmp',
  '.bz2',
  '.csv',
  '.doc',
  '.docx',
  '.flac',
  '.gif',
  '.gz',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.json',
  '.log',
  '.m4a',
  '.m4v',
  '.markdown',
  '.md',
  '.mdx',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.odf',
  '.odp',
  '.ods',
  '.odt',
  '.ogg',
  '.opus',
  '.pdf',
  '.png',
  '.ppt',
  '.pptx',
  '.rar',
  '.rst',
  '.rtf',
  '.svg',
  '.tar',
  '.tgz',
  '.toml',
  '.tsv',
  '.txt',
  '.wav',
  '.webm',
  '.webp',
  '.xls',
  '.xlsx',
  '.xml',
  '.xz',
  '.yaml',
  '.yml',
  '.zip',
])
const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.command',
  '.cpl',
  '.desktop',
  '.exe',
  '.hta',
  '.js',
  '.jse',
  '.lnk',
  '.msi',
  '.pif',
  '.ps1',
  '.scr',
  '.sh',
  '.url',
  '.vbe',
  '.vbs',
  '.wsf',
  '.wsh',
])

export function normalizeExternalUrl(target: string): string {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error('External shell targets must be absolute URLs')
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Unsupported external URL scheme: ${url.protocol}`)
  }
  return url.toString()
}

/**
 * Expands a leading tilde to the home directory. `~\` is only a tilde path on
 * Windows — on POSIX the backslash is a valid filename character.
 */
export function expandTildePath(target: string, platform: NodeJS.Platform = process.platform): string {
  if (
    target === '~' ||
    target.startsWith('~/') ||
    (platform === 'win32' && target.startsWith('~\\'))
  ) {
    return homedir() + target.slice(1)
  }
  return target
}

function assertLocalWindowsPath(target: string): void {
  const windowsPath = target.replaceAll('/', '\\')
  if (
    windowsPath.startsWith('\\\\') ||
    windowsPath.startsWith('\\??\\') ||
    (path.win32.isAbsolute(windowsPath) && !/^[A-Za-z]:\\/.test(windowsPath))
  ) {
    throw new Error('System file paths must be local paths')
  }
}

type WindowsPathDeps = {
  assertSafePath?: (target: string) => Promise<void>
}

const WINDOWS_PATH_SAFETY_SCRIPT = [
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class NativePath { [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint QueryDosDevice(string name, StringBuilder target, int length); [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetDriveType(string root); [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)] public static extern uint GetFileAttributes(string path); }'",
  '$target = $env:CC_HAHA_SAFE_PATH',
  '$root = [System.IO.Path]::GetPathRoot($target)',
  '$buffer = New-Object System.Text.StringBuilder 32768',
  "$driveName = $root.TrimEnd('\\')",
  'if ([NativePath]::QueryDosDevice($driveName, $buffer, $buffer.Capacity) -eq 0) { exit 2 }',
  "if ([NativePath]::GetDriveType($root) -notin @(2, 3, 5, 6)) { exit 3 }",
  "if ($buffer.ToString() -notmatch '^\\\\Device\\\\(?:HarddiskVolume\\d+|CdRom\\d+|Floppy\\d+|Ramdisk\\w*)$') { exit 4 }",
  '$current = $root',
  'foreach ($segment in $target.Substring($root.Length).Split(@([char]92, [char]47), [System.StringSplitOptions]::RemoveEmptyEntries)) { $current = [System.IO.Path]::Combine($current, $segment); $attributes = [NativePath]::GetFileAttributes($current); if ($attributes -eq 0xFFFFFFFF) { exit 5 }; if (($attributes -band 0x400) -ne 0) { exit 6 } }',
].join('; ')

export function assertSafeWindowsPath(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const systemRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || env.WINDIR?.trim()
  const normalizedTarget = path.win32.normalize(target)
  const root = path.win32.parse(normalizedTarget).root
  if (!systemRoot || !/^[A-Za-z]:\\$/.test(root)) {
    return Promise.reject(new Error('System file paths must use direct local volumes'))
  }
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_PATH_SAFETY_SCRIPT,
    ], {
      cwd: systemRoot,
      encoding: 'utf8',
      env: { ...env, CC_HAHA_SAFE_PATH: normalizedTarget },
      windowsHide: true,
      timeout: 5_000,
    }, (error) => {
      if (error) {
        reject(new Error('System file paths must use direct local volumes without reparse points'))
        return
      }
      resolve()
    })
  })
}

export async function normalizeRevealPath(
  target: string,
  platform: NodeJS.Platform = process.platform,
  deps: WindowsPathDeps = {},
): Promise<string> {
  const fileUrl = target.slice(0, 5).toLowerCase() === 'file:'
    ? new URL(target)
    : null
  if (platform === 'win32' && fileUrl?.hostname) {
    throw new Error('System file paths must be local paths')
  }

  const filePath = expandTildePath(
    fileUrl ? fileURLToPath(fileUrl) : target,
    platform,
  )
  if (platform === 'win32') assertLocalWindowsPath(filePath)
  if (!path.isAbsolute(filePath)) {
    throw new Error('System file paths must be absolute')
  }
  if (platform === 'win32') {
    await (deps.assertSafePath ?? assertSafeWindowsPath)(filePath)
  }
  const realPath = realpathSync(filePath)
  if (platform === 'win32') assertLocalWindowsPath(realPath)
  const stat = statSync(realPath)
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error('System file paths must point to a file or directory')
  }
  return realPath
}

export async function normalizeOpenPath(
  target: string,
  platform: NodeJS.Platform = process.platform,
  deps: WindowsPathDeps = {},
): Promise<string> {
  const realPath = await normalizeRevealPath(target, platform, deps)
  const stat = statSync(realPath)
  if (isBlockedSystemPath(realPath, stat.isDirectory(), platform)) {
    throw new Error('System file paths must not point to executable apps or scripts')
  }
  return realPath
}

export function isBlockedSystemPath(
  realPath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform,
) {
  const ext = path.extname(realPath).toLowerCase()
  if (BLOCKED_EXECUTABLE_EXTENSIONS.has(ext)) return true
  if (isDirectory) return false
  if (platform === 'win32') return !ALLOWED_SYSTEM_FILE_EXTENSIONS.has(ext)
  return (statSync(realPath).mode & 0o111) !== 0
}

export async function openExternalUrl(target: string): Promise<void> {
  const { shell } = await import('electron')
  await shell.openExternal(normalizeExternalUrl(target))
}

export function normalizeSystemSettingsUrl(target: string): string {
  if (!ALLOWED_SYSTEM_SETTINGS_URLS.has(target)) {
    throw new Error(`Unsupported system settings URL: ${target}`)
  }
  return target
}

export async function openSystemSettingsUrl(target: string): Promise<boolean> {
  const { shell } = await import('electron')
  await shell.openExternal(normalizeSystemSettingsUrl(target))
  return true
}

export async function openSystemPath(target: string): Promise<void> {
  const { shell } = await import('electron')
  const error = await shell.openPath(await normalizeOpenPath(target))
  if (error) throw new Error(error)
}

/**
 * Reveal a file in the OS file manager (Finder / Explorer / xdg-open) with the
 * file itself selected. Unlike openPath, this targets the file's parent
 * directory and highlights the file — preferred for "show me where this is".
 */
export async function showItemInFolder(target: string): Promise<void> {
  const { shell } = await import('electron')
  shell.showItemInFolder(await normalizeRevealPath(target))
}
