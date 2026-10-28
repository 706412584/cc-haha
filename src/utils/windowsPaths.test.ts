import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { tryFindGitBashPath } from './windowsPaths.js'

const originalOverride = process.env.CLAUDE_CODE_GIT_BASH_PATH
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  if (originalOverride === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH
  else process.env.CLAUDE_CODE_GIT_BASH_PATH = originalOverride
  tryFindGitBashPath.cache.clear!()
})

describe('Windows Git Bash discovery', () => {
  test('finds the standard Git installation without launching any process', () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    const git = 'C:\\Program Files\\Git\\cmd\\git.exe'
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    // This fork probes with statSync().isFile() rather than existsSync, so a
    // directory or link cannot masquerade as an executable.
    const exists = spyOn(fs, 'statSync').mockImplementation(file => {
      if (file === git || file === bash) return { isFile: () => true } as fs.Stats
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    cleanups.push(() => exists.mockRestore())
    // The fork canonicalizes every candidate through realpath before the
    // workspace-escape check; the fixture paths do not exist on disk.
    const realpath = spyOn(fs, 'realpathSync').mockImplementation((file => String(file)) as typeof fs.realpathSync)
    ;(realpath as unknown as { native: (p: string) => string }).native = (file: string) => String(file)
    cleanups.push(() => realpath.mockRestore())
    const shell = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('Discovery must not launch cmd.exe')
    })
    cleanups.push(() => shell.mockRestore())
    const where = spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('Standard installation does not need executable lookup')
    })
    cleanups.push(() => where.mockRestore())
    tryFindGitBashPath.cache.clear!()

    expect(tryFindGitBashPath()).toBe(bash)
    expect(shell).not.toHaveBeenCalled()
    expect(where).not.toHaveBeenCalled()
  })

  test('checks an explicit path as a literal file without launching a command shell', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-shell-discovery-'))
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
    const binary = path.join(directory, 'bash & 100%.exe')
    fs.writeFileSync(binary, '')
    process.env.CLAUDE_CODE_GIT_BASH_PATH = binary
    const shell = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('Filesystem discovery must not create a console')
    })
    cleanups.push(() => shell.mockRestore())
    tryFindGitBashPath.cache.clear!()

    expect(tryFindGitBashPath()).toBe(binary)
    expect(shell).not.toHaveBeenCalled()
    fs.unlinkSync(binary)
    tryFindGitBashPath.cache.clear!()
    expect(tryFindGitBashPath()).toBeNull()
    expect(shell).not.toHaveBeenCalled()
  })

  test('hides the where.exe fallback console and skips workspace executables', () => {
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH
    const installedGit = path.resolve(os.tmpdir(), 'cc-haha-installed-git', 'cmd', 'git.exe')
    const installedBash = path.win32.join(installedGit, '..', '..', 'bin', 'bash.exe')
    // The fork only consults where.exe when the trusted copy itself exists.
    const trustedWhere = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe')
    const exists = spyOn(fs, 'statSync').mockImplementation(file => {
      if (file === installedBash || file === trustedWhere) return { isFile: () => true } as fs.Stats
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    cleanups.push(() => exists.mockRestore())
    const realpath = spyOn(fs, 'realpathSync').mockImplementation((file => String(file)) as typeof fs.realpathSync)
    ;(realpath as unknown as { native: (p: string) => string }).native = (file: string) => String(file)
    cleanups.push(() => realpath.mockRestore())
    const where = spyOn(childProcess, 'execFileSync').mockReturnValue(
      `${path.join(process.cwd(), 'git.exe')}\r\n${installedGit}\r\n`,
    )
    cleanups.push(() => where.mockRestore())
    const shell = spyOn(childProcess, 'execSync').mockImplementation(() => {
      throw new Error('Discovery must not launch cmd.exe')
    })
    cleanups.push(() => shell.mockRestore())
    tryFindGitBashPath.cache.clear!()

    expect(tryFindGitBashPath()).toBe(installedBash)
    // The fork runs the trusted System32 copy with an explicit stdio so no
    // console can appear; upstream asserted only encoding and windowsHide.
    const whereCall = where.mock.calls[0]
    // The fork resolves where.exe from SystemRoot instead of trusting PATH.
    expect(whereCall?.[0]).toBe(trustedWhere)
    expect(whereCall?.[1]).toEqual(['git'])
    expect(whereCall?.[2]).toMatchObject({
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    expect(shell).not.toHaveBeenCalled()
  })
})
