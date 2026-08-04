import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let tempDir: string | null = null

afterEach(async () => {
  if (!tempDir) return
  await rm(tempDir, { recursive: true, force: true })
  tempDir = null
})

test.serial('in-process shutdown waits for stdout drain and callback before exit', async () => {
  const isolatedDir = await mkdtemp(join(tmpdir(), 'cc-haha-shutdown-direct-'))
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalHome = process.env.HOME
  const originalNonessentialTraffic =
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  const originalDisableTelemetry = process.env.DISABLE_TELEMETRY
  const originalExitCode = process.exitCode

  process.env.CLAUDE_CONFIG_DIR = join(isolatedDir, '.claude')
  process.env.HOME = isolatedDir
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  process.env.DISABLE_TELEMETRY = '1'

  const { flushProcessOutput, writeToStdout } = await import('./process.js')
  const { gracefulShutdown, resetShutdownState } = await import(
    './gracefulShutdown.js'
  )
  let writeCallback: ((error?: Error | null) => void) | undefined
  spyOn(process.stdout, 'write').mockImplementation(((_data, callback) => {
    writeCallback = callback as (error?: Error | null) => void
    return false
  }) as typeof process.stdout.write)
  const exit = spyOn(process, 'exit').mockImplementation(
    (() => undefined) as (code?: string | number | null) => never,
  )

  try {
    writeToStdout('{"type":"result"}\n')
    const shutdown = gracefulShutdown(0)
    for (let i = 0; i < 10; i += 1) await Promise.resolve()

    expect(exit).not.toHaveBeenCalled()
    process.stdout.emit('drain')
    await Promise.resolve()
    expect(exit).not.toHaveBeenCalled()

    writeCallback?.()
    await shutdown
    expect(exit).toHaveBeenCalledWith(0)
  } finally {
    resetShutdownState()
    mock.restore()
    await flushProcessOutput()
    process.exitCode = originalExitCode
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalNonessentialTraffic === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    } else {
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC =
        originalNonessentialTraffic
    }
    if (originalDisableTelemetry === undefined) {
      delete process.env.DISABLE_TELEMETRY
    } else {
      process.env.DISABLE_TELEMETRY = originalDisableTelemetry
    }
    await rm(isolatedDir, { recursive: true, force: true })
  }
})

test('subprocess shutdown exits only after pending stdout is flushed', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cc-haha-shutdown-drain-'))
  const markerPath = join(tempDir, 'write-callback-completed')
  const processModule = pathToFileURL(resolve('src/utils/process.ts')).href
  const shutdownModule = pathToFileURL(
    resolve('src/utils/gracefulShutdown.ts'),
  ).href
  const script = `
    import { writeFileSync } from 'node:fs'
    const { writeToStdout } = await import(${JSON.stringify(processModule)})
    const { gracefulShutdown } = await import(${JSON.stringify(shutdownModule)})
    process.stdout.write = ((_data, _encoding, callback) => {
      const done = typeof _encoding === 'function' ? _encoding : callback
      setTimeout(() => process.stdout.emit('drain'), 25)
      setTimeout(() => {
        writeFileSync(${JSON.stringify(markerPath)}, 'done')
        done?.()
      }, 125)
      return false
    })
    writeToStdout('{"type":"result"}\\n')
    await gracefulShutdown(0)
  `

  const child = Bun.spawn(
    [
      process.execPath,
      '--preload',
      resolve('preload.ts'),
      '-e',
      script,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CI: '1',
        HOME: tempDir,
        CLAUDE_CONFIG_DIR: join(tempDir, '.claude'),
        CC_HAHA_SKIP_DOTENV: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ])

  expect(exitCode, stderr).toBe(0)
  await access(markerPath)
}, 15_000)
