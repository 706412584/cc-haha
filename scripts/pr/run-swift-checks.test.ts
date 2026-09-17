import { describe, expect, mock, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { runSwiftChecks } from './run-swift-checks'

describe('Swift platform checks', () => {
  test.each(['linux', 'win32'] as const)('does not invoke the macOS-only package on %s', async platform => {
    const run = mock(async () => { throw new Error('Swift cannot run on this fixture platform') })
    expect(await runSwiftChecks({ platform, run })).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })

  test.each([
    { swiftExit: 0, packagingExit: 0, expected: 0, calls: 2 },
    { swiftExit: 7, packagingExit: 0, expected: 7, calls: 1 },
    { swiftExit: 0, packagingExit: 9, expected: 9, calls: 2 },
  ])('runs Swift and shell packaging regressions in isolation and propagates their result: %j', async scenario => {
    let home = ''
    const commands: string[][] = []
    const run = mock(async (command: string[], options: { cwd: string; env: Record<string, string> }) => {
      commands.push(command)
      home = options.env.HOME!
      if (command[0] === 'swift') {
        expect(command.slice(0, 2)).toEqual(['swift', 'test'])
        expect(command).toContain('--enable-xctest')
        expect(command[command.indexOf('--package-path') + 1]).toBe(join(options.cwd, 'native/cu-helper'))
        expect(command[command.indexOf('--scratch-path') + 1]).toBe(join(home, 'build'))
      } else {
        expect(command).toEqual(['bun', 'test', join(options.cwd, 'native/cu-helper/build.test.ts')])
        expect(commands[0]?.[0]).toBe('swift')
      }
      expect(isAbsolute(options.cwd)).toBe(true)
      expect(home).not.toBe(process.env.HOME)
      expect(options.env.CLAUDE_CONFIG_DIR).toBe(join(home, '.claude'))
      expect(options.env.CFFIXED_USER_HOME).toBe(home)
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(options.env.GH_TOKEN).toBeUndefined()
      writeFileSync(join(home, 'cleanup-fixture'), 'disposable Swift test output')
      return command[0] === 'swift' ? scenario.swiftExit : scenario.packagingExit
    })
    expect(await runSwiftChecks({ platform: 'darwin', run })).toBe(scenario.expected)
    expect(run).toHaveBeenCalledTimes(scenario.calls)
    expect(existsSync(home)).toBe(false)
  })

  // macOS runners intermittently remount TMPDIR read-only, so the sandbox
  // removal throws EROFS after the Swift lane already passed. Cleanup failure
  // must not be reported as a lane failure.
  test.each([
    { swiftExit: 0, packagingExit: 0, expected: 0 },
    { swiftExit: 3, packagingExit: 0, expected: 3 },
  ])('keeps the test result when sandbox cleanup fails: %j', async scenario => {
    const run = mock(async (command: string[]) => (
      command[0] === 'swift' ? scenario.swiftExit : scenario.packagingExit
    ))
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (message: string) => { warnings.push(message) }

    let attempted = ''
    try {
      expect(await runSwiftChecks({
        platform: 'darwin',
        run,
        removeSandbox: directory => {
          attempted = directory
          throw new Error('EROFS: read-only file system')
        },
      })).toBe(scenario.expected)
    } finally {
      console.warn = originalWarn
    }

    expect(attempted).not.toBe('')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not remove sandbox')
    expect(warnings[0]).toContain('EROFS')
  })

  test('cleans the sandbox and reports a Swift launch failure', async () => {
    let home = ''
    await expect(runSwiftChecks({
      platform: 'darwin',
      run: async (_command, options) => {
        home = options.env.HOME!
        throw new Error('swift executable unavailable')
      },
    })).rejects.toThrow('swift executable unavailable')
    expect(existsSync(home)).toBe(false)
  })
})
