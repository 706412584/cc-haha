import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandTildePath,
  isBlockedSystemPath,
  normalizeExternalUrl,
  normalizeOpenPath,
  normalizeRevealPath,
  normalizeSystemSettingsUrl,
} from './shell'

describe('Electron shell service', () => {
  it('allows only explicit external URL schemes', () => {
    expect(normalizeExternalUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(normalizeExternalUrl('mailto:support@example.com')).toBe('mailto:support@example.com')
    expect(() => normalizeExternalUrl('file:///tmp/report.md')).toThrow('Unsupported external URL scheme')
    expect(() => normalizeExternalUrl('/tmp/report.md')).toThrow('absolute URLs')
  })

  it('allows only existing non-executable file-system paths for openPath', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'electron-shell-'))
    const reportPath = join(rootDir, 'report.md')
    const folderPath = join(rootDir, 'folder')
    const scriptPath = join(rootDir, 'run.sh')
    const appPath = join(rootDir, 'Tool.app')
    try {
      writeFileSync(reportPath, 'ok')
      mkdirSync(folderPath)
      writeFileSync(scriptPath, '#!/bin/sh\n')
      chmodSync(scriptPath, 0o755)
      mkdirSync(appPath)

      await expect(normalizeOpenPath(reportPath)).resolves.toBe(realpathSync(reportPath))
      await expect(normalizeOpenPath(reportPath.replaceAll('\\', '/'))).resolves.toBe(realpathSync(reportPath))
      await expect(normalizeOpenPath(new URL(`file://${reportPath}`).toString())).resolves.toBe(realpathSync(reportPath))
      await expect(normalizeOpenPath(folderPath)).resolves.toBe(realpathSync(folderPath))
      await expect(normalizeOpenPath(scriptPath)).rejects.toThrow('executable')
      await expect(normalizeOpenPath(appPath)).rejects.toThrow('executable')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
    await expect(normalizeOpenPath('relative/report.md')).rejects.toThrow('absolute')
  })

  it('rejects unsafe Windows paths before resolving them', async () => {
    let verifiedPath = ''
    await expect(normalizeOpenPath(
      'Z:\\attachments\\report.pdf',
      'win32',
      {
        assertSafePath: async (target) => {
          verifiedPath = target
          throw new Error('reparse points')
        },
      },
    )).rejects.toThrow('reparse points')
    expect(verifiedPath).toBe('Z:\\attachments\\report.pdf')
  })

  it.runIf(process.platform === 'win32')('rejects real Windows junctions and missing paths', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'electron-shell-junction-'))
    const targetDir = join(rootDir, 'target')
    const junctionDir = join(rootDir, 'junction')
    try {
      mkdirSync(targetDir)
      writeFileSync(join(targetDir, 'report.pdf'), 'report')
      symlinkSync(targetDir, junctionDir, 'junction')

      await expect(normalizeOpenPath(join(junctionDir, 'report.pdf'))).rejects.toThrow('reparse points')
      await expect(normalizeOpenPath(join(rootDir, 'missing.pdf'))).rejects.toThrow('reparse points')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('rejects Windows shell shortcuts and script-host file types', () => {
    const blockedExtensions = [
      '.lnk',
      '.pif',
      '.url',
      '.hta',
      '.js',
      '.jse',
      '.vbs',
      '.vbe',
      '.wsf',
      '.wsh',
      '.command',
      '.cpl',
      '.desktop',
    ]
    for (const extension of blockedExtensions) {
      expect(isBlockedSystemPath(`C:\\attachments\\payload${extension.toUpperCase()}`, false, 'win32')).toBe(true)
    }
  })

  it('allows only known document, archive, and media file types on Windows', () => {
    const allowedExtensions = [
      '.pdf',
      '.zip',
      '.7z',
      '.rar',
      '.tar',
      '.gz',
      '.tgz',
      '.bz2',
      '.xz',
      '.mdx',
      '.markdown',
      '.rst',
      '.m4a',
      '.flac',
      '.aac',
      '.ogg',
      '.opus',
      '.m4v',
      '.mkv',
      '.avi',
      '.ico',
    ]
    for (const extension of allowedExtensions) {
      expect(isBlockedSystemPath(`C:\\attachments\\attachment${extension.toUpperCase()}`, false, 'win32')).toBe(false)
    }

    expect(isBlockedSystemPath('C:\\attachments\\attachment.unknown', false, 'win32')).toBe(true)
    expect(isBlockedSystemPath('C:\\attachments\\invoice.pdf.PIF', false, 'win32')).toBe(true)
  })

  it('reveals session and output files without allowing the system to open them', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'electron-shell-reveal-'))
    const sessionPath = join(rootDir, 'session.jsonl')
    const outputPath = join(rootDir, 'task.output')
    try {
      writeFileSync(sessionPath, 'session')
      writeFileSync(outputPath, 'output')

      await expect(normalizeRevealPath(sessionPath)).resolves.toBe(realpathSync(sessionPath))
      await expect(normalizeRevealPath(outputPath)).resolves.toBe(realpathSync(outputPath))
      expect(isBlockedSystemPath('C:\\sessions\\session.jsonl', false, 'win32')).toBe(true)
      expect(isBlockedSystemPath('C:\\outputs\\task.output', false, 'win32')).toBe(true)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('expands tilde paths per platform', () => {
    expect(expandTildePath('~', 'darwin')).toBe(homedir())
    expect(expandTildePath('~/reports/a.html', 'linux')).toBe(`${homedir()}/reports/a.html`)
    expect(expandTildePath('~\\reports\\a.html', 'win32')).toBe(`${homedir()}\\reports\\a.html`)
    // On POSIX "~\..." is a regular file name; "~user" expansion is unsupported.
    expect(expandTildePath('~\\reports\\a.html', 'darwin')).toBe('~\\reports\\a.html')
    expect(expandTildePath('~user/file.md', 'linux')).toBe('~user/file.md')
    expect(expandTildePath('a/~/b.md', 'linux')).toBe('a/~/b.md')
  })

  it('expands tilde paths before the absolute-path check in openPath', async () => {
    await expect(normalizeOpenPath('~')).resolves.toBe(realpathSync(homedir()))
  })

  it('rejects remote and device paths before touching the file system', async () => {
    const unsafePaths = [
      '\\\\attacker-host\\share\\result.txt',
      '//attacker-host/share/result.txt',
      '\\/attacker-host/share/result.txt',
      '/\\attacker-host/share/result.txt',
      '\\\\?\\UNC\\attacker-host\\share\\result.txt',
      '\\/?\\UNC\\attacker-host\\share\\result.txt',
      '/\\?\\UNC\\attacker-host\\share\\result.txt',
      '\\??\\UNC\\attacker-host\\share\\result.txt',
      'file://attacker-host/share/result.txt',
      'FILE://attacker-host/share/result.txt',
    ]

    for (const unsafePath of unsafePaths) {
      await expect(normalizeOpenPath(unsafePath, 'win32')).rejects.toThrow('local paths')
    }
  })

  it('allows only explicit system settings URLs', () => {
    expect(normalizeSystemSettingsUrl('ms-settings:notifications')).toBe('ms-settings:notifications')
    expect(normalizeSystemSettingsUrl('x-apple.systempreferences:com.apple.preference.notifications')).toBe(
      'x-apple.systempreferences:com.apple.preference.notifications',
    )
    expect(() => normalizeSystemSettingsUrl('ms-settings:privacy')).toThrow('Unsupported system settings URL')
  })
})
