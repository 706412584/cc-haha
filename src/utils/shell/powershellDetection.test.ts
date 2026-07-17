import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  findExecutables,
  resolveGitBashPathFromGitExecutables,
  resolveTrustedWherePath,
} from '../windowsPaths.js'
import {
  findPowerShell,
  isPowerShellExecutablePath,
  resolvePowerShellPathOverride,
} from './powershellDetection.js'

describe('Windows shell discovery', () => {
  test('resolves where.exe only from the Windows system directory', () => {
    expect(resolveTrustedWherePath({ SystemRoot: 'D:\\WinRoot' })).toBe(
      'D:\\WinRoot\\System32\\where.exe',
    )
    expect(resolveTrustedWherePath({})).toBeNull()
  })

  test('keeps every trusted PATH result so a later full Git install can provide Bash', () => {
    const candidates = findExecutables('git', {
      cwd: 'C:\\workspace',
      defaultLocations: [],
      exists: path => path === 'C:\\Windows\\System32\\where.exe',
      realpath: path => path,
      runWhere: () => [
        'C:\\Tools\\MinGit\\cmd\\git.exe',
        'D:\\Tools\\Git\\cmd\\git.exe',
      ].join('\r\n'),
      wherePath: 'C:\\Windows\\System32\\where.exe',
    })

    expect(candidates).toEqual([
      'C:\\Tools\\MinGit\\cmd\\git.exe',
      'D:\\Tools\\Git\\cmd\\git.exe',
    ])
    expect(resolveGitBashPathFromGitExecutables(
      candidates,
      path => path === 'D:\\Tools\\Git\\bin\\bash.exe',
      path => path,
    )).toBe('D:\\Tools\\Git\\bin\\bash.exe')
  })

  test('returns canonical Git paths instead of executable aliases from the current directory', () => {
    expect(findExecutables('git', {
      cwd: 'C:\\workspace',
      defaultLocations: [],
      exists: () => true,
      realpath: path => path === 'C:\\workspace\\git.exe'
        ? 'D:\\Tools\\Git\\cmd\\git.exe'
        : path,
      runWhere: () => 'C:\\workspace\\git.exe',
      wherePath: 'C:\\Windows\\System32\\where.exe',
    })).toEqual(['D:\\Tools\\Git\\cmd\\git.exe'])
  })

  test('rejects Bash aliases that resolve outside the canonical Git installation root', () => {
    expect(resolveGitBashPathFromGitExecutables(
      ['D:\\Tools\\Git\\cmd\\git.exe'],
      path => path === 'D:\\Tools\\Git\\bin\\bash.exe',
      path => path.endsWith('bash.exe')
        ? 'C:\\workspace\\bin\\bash.exe'
        : path,
    )).toBeNull()
  })

  test('keeps trusted default Git locations when PATH lookup fails', () => {
    expect(findExecutables('git', {
      cwd: 'C:\\workspace',
      defaultLocations: ['D:\\Tools\\Git\\cmd\\git.exe'],
      exists: () => true,
      realpath: path => path,
      runWhere: () => { throw new Error('where failed') },
      wherePath: 'C:\\Windows\\System32\\where.exe',
    })).toEqual(['D:\\Tools\\Git\\cmd\\git.exe'])
  })

  test('finds Bash when mingw64 git appears before the cmd shim', () => {
    const existing = new Set([
      'D:\\Tools\\Git\\bin\\bash.exe',
      'D:\\Tools\\Git\\usr\\bin\\bash.exe',
    ])

    expect(resolveGitBashPathFromGitExecutables([
      'D:\\Tools\\Git\\mingw64\\bin\\git.exe',
      'D:\\Tools\\Git\\cmd\\git.exe',
    ], candidate => existing.has(candidate), path => path)).toBe(
      'D:\\Tools\\Git\\bin\\bash.exe',
    )
  })

  test('uses trusted Program Files defaults and real filesystem probes', () => {
    const root = mkdtempSync(join(tmpdir(), 'windows-shell-discovery-'))
    const programFiles = join(root, 'Program Files')
    const gitPath = join(programFiles, 'Git', 'cmd', 'git.exe')
    try {
      mkdirSync(dirname(gitPath), { recursive: true })
      writeFileSync(gitPath, '')

      expect(findExecutables('git', {
        cwd: join(root, 'workspace'),
        env: { ProgramFiles: programFiles },
        wherePath: null,
        realpath: path => path,
      })).toEqual([gitPath])
      expect(findExecutables('node', {
        cwd: join(root, 'workspace'),
        env: { ProgramFiles: programFiles },
        wherePath: null,
        realpath: path => path,
      })).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects cwd candidates and ignores canonicalization failures and duplicates', () => {
    const canonical = 'D:\\Tools\\Git\\cmd\\git.exe'
    expect(findExecutables('git', {
      cwd: 'C:\\workspace',
      defaultLocations: [],
      exists: () => true,
      realpath: path => {
        if (path === 'C:\\broken\\git.exe') throw new Error('broken alias')
        return path
      },
      runWhere: () => [
        'C:\\workspace\\git.exe',
        'C:\\broken\\git.exe',
        canonical,
        canonical,
      ].join('\r\n'),
      wherePath: 'C:\\Windows\\System32\\where.exe',
    })).toEqual([canonical])
  })

  test('skips unsupported Git layouts and Bash canonicalization failures', () => {
    expect(resolveGitBashPathFromGitExecutables(
      ['D:\\Tools\\PortableGit\\git.exe'],
      () => true,
      path => path,
    )).toBeNull()

    expect(resolveGitBashPathFromGitExecutables(
      ['D:\\Tools\\Git\\cmd\\git.exe'],
      path => path.endsWith('bash.exe'),
      path => {
        if (path.endsWith('git.exe')) return path
        throw new Error('broken Bash alias')
      },
    )).toBeNull()

    expect(resolveGitBashPathFromGitExecutables(
      ['D:\\Tools\\Git\\cmd\\git.exe'],
      () => false,
      path => path,
    )).toBeNull()
  })

  test('accepts pwsh and powershell executable paths', () => {
    expect(
      isPowerShellExecutablePath('C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
    ).toBe(true)
    expect(
      isPowerShellExecutablePath(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ),
    ).toBe(true)
  })

  test('rejects custom shells that are not PowerShell executables', () => {
    expect(
      isPowerShellExecutablePath('C:\\Program Files\\Git\\bin\\bash.exe'),
    ).toBe(false)
    expect(isPowerShellExecutablePath('cmd.exe')).toBe(false)
  })

  test('resolves configured command names through PATH lookup', async () => {
    const resolved = await resolvePowerShellPathOverride('pwsh.exe', {
      getPlatform: () => 'macos',
      probePath: async () => null,
      which: async command =>
        command === 'pwsh.exe'
          ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
          : null,
    })

    expect(resolved).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  test('maps bare Windows overrides to trusted install paths without probing cwd or PATH', async () => {
    const probed: string[] = []
    const resolved = await resolvePowerShellPathOverride('pwsh.exe', {
      env: { ProgramFiles: 'C:\\Program Files' },
      getPlatform: () => 'windows',
      probePath: async path => {
        probed.push(path)
        return path === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' ? path : null
      },
      which: async () => { throw new Error('must not search PATH') },
    })

    expect(resolved).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(probed).toEqual(['C:\\Program Files\\PowerShell\\7\\pwsh.exe'])
  })

  test('falls back to known Windows PowerShell install paths', async () => {
    const resolved = await resolvePowerShellPathOverride('powershell.exe', {
      env: { SystemRoot: 'C:\\Windows' },
      getPlatform: () => 'windows',
      probePath: async path =>
        path ===
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
          ? path
          : null,
      which: async () => null,
    })

    expect(resolved).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  test('uses the configured Windows system root for the fallback path', async () => {
    const systemPowerShell =
      'D:\\WinRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const resolved = await findPowerShell({
      env: { SystemRoot: 'D:\\WinRoot' },
      getPlatform: () => 'windows',
      probePath: async path => path === systemPowerShell ? path : null,
      which: async () => null,
    })

    expect(resolved).toBe(systemPowerShell)
  })

  test('uses Program Files without spawning a shell for PowerShell 7 fallback', async () => {
    const pwshPath = 'D:\\Apps\\PowerShell\\7\\pwsh.exe'
    const resolved = await resolvePowerShellPathOverride('pwsh.exe', {
      env: { ProgramFiles: 'D:\\Apps' },
      getPlatform: () => 'windows',
      probePath: async path => path === pwshPath ? path : null,
      which: async () => null,
    })

    expect(resolved).toBe(pwshPath)
  })

  test('prefers the trusted PowerShell 7 fallback before Windows PowerShell', async () => {
    const pwshPath = 'D:\\Apps\\PowerShell\\7\\pwsh.exe'
    const windowsPowerShell =
      'D:\\WinRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const resolved = await findPowerShell({
      env: { ProgramFiles: 'D:\\Apps', SystemRoot: 'D:\\WinRoot' },
      getPlatform: () => 'windows',
      powershellPathOverride: null,
      probePath: async path => [pwshPath, windowsPowerShell].includes(path) ? path : null,
      which: async command => command === 'powershell' ? windowsPowerShell : null,
    })

    expect(resolved).toBe(pwshPath)
  })

  test('does not guess fixed Windows paths when system directories are unavailable', async () => {
    const resolved = await findPowerShell({
      env: {},
      getPlatform: () => 'windows',
      powershellPathOverride: null,
      probePath: async path => path,
      which: async () => null,
    })

    expect(resolved).toBeNull()
  })

  test('finds Windows PowerShell by its system path when packaged PATH is incomplete', async () => {
    const systemPowerShell =
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const resolved = await findPowerShell({
      env: { SystemRoot: 'C:\\Windows' },
      getPlatform: () => 'windows',
      probePath: async path => path === systemPowerShell ? path : null,
      which: async () => null,
    })

    expect(resolved).toBe(systemPowerShell)
  })

  test('preserves explicit absolute overrides and non-Windows PATH fallbacks', async () => {
    await expect(resolvePowerShellPathOverride('/opt/pwsh', {
      getPlatform: () => 'linux',
      probePath: async path => path,
      which: async () => null,
    })).resolves.toBe('/opt/pwsh')

    await expect(findPowerShell({
      getPlatform: () => 'macos',
      powershellPathOverride: null,
      which: async command => command === 'powershell' ? '/usr/local/bin/powershell' : null,
    })).resolves.toBe('/usr/local/bin/powershell')
  })

  test('returns a non-snap pwsh path unchanged on Linux', async () => {
    await expect(findPowerShell({
      getPlatform: () => 'linux',
      powershellPathOverride: null,
      which: async command => command === 'pwsh' ? '/usr/local/bin/pwsh' : null,
    })).resolves.toBe('/usr/local/bin/pwsh')
  })

  test('ignores missing or non-PowerShell overrides', async () => {
    await expect(
      resolvePowerShellPathOverride('C:\\Tools\\bash.exe', {
        probePath: async () => 'C:\\Tools\\bash.exe',
        which: async () => null,
      }),
    ).resolves.toBeNull()

    await expect(
      resolvePowerShellPathOverride('C:\\Missing\\pwsh.exe', {
        getPlatform: () => 'macos',
        probePath: async () => null,
        which: async () => null,
      }),
    ).resolves.toBeNull()
  })
})
