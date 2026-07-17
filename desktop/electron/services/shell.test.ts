import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

  it('allows only existing non-executable file-system paths for openPath', () => {
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

      expect(normalizeOpenPath(reportPath)).toBe(realpathSync(reportPath))
      expect(normalizeOpenPath(new URL(`file://${reportPath}`).toString())).toBe(realpathSync(reportPath))
      expect(normalizeOpenPath(folderPath)).toBe(realpathSync(folderPath))
      expect(() => normalizeOpenPath(scriptPath)).toThrow('executable')
      expect(() => normalizeOpenPath(appPath)).toThrow('executable')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
    expect(() => normalizeOpenPath('relative/report.md')).toThrow('absolute')
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

  it('reveals session and output files without allowing the system to open them', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'electron-shell-reveal-'))
    const sessionPath = join(rootDir, 'session.jsonl')
    const outputPath = join(rootDir, 'task.output')
    try {
      writeFileSync(sessionPath, 'session')
      writeFileSync(outputPath, 'output')

      expect(normalizeRevealPath(sessionPath)).toBe(realpathSync(sessionPath))
      expect(normalizeRevealPath(outputPath)).toBe(realpathSync(outputPath))
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

  it('expands tilde paths before the absolute-path check in openPath', () => {
    expect(normalizeOpenPath('~')).toBe(realpathSync(homedir()))
  })

  it('rejects remote and device paths before touching the file system', () => {
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
      expect(() => normalizeOpenPath(unsafePath, 'win32')).toThrow('local paths')
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
