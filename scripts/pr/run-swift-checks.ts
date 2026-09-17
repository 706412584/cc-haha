#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from './test-environment'

type SwiftCheckRunner = (
  command: string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<number>

export async function runSwiftChecks(options: {
  platform?: NodeJS.Platform
  run?: SwiftCheckRunner
  removeSandbox?: (sandboxHome: string) => void
} = {}): Promise<number> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    console.log(`[swift-checks] not applicable on ${platform}: cu-helper targets macOS; PR CI requires the macOS Swift job separately`)
    return 0
  }

  const root = resolve(import.meta.dir, '../..')
  const sandboxHome = mkdtempSync(join(tmpdir(), 'cc-haha-swift-checks-'))
  const run = options.run ?? (async (command, spawnOptions) => {
    const child = Bun.spawn(command, { ...spawnOptions, stdout: 'inherit', stderr: 'inherit' })
    return await child.exited
  })
  const removeSandbox = options.removeSandbox ?? ((directory: string) => {
    rmSync(directory, { recursive: true, force: true })
  })
  try {
    const env = createSandboxedTestEnvironment(sandboxHome, { CFFIXED_USER_HOME: sandboxHome })
    const swiftExit = await run([
      'swift', 'test',
      '--package-path', join(root, 'native/cu-helper'),
      '--scratch-path', join(sandboxHome, 'build'),
      '--enable-xctest',
    ], { cwd: root, env })
    if (swiftExit !== 0) return swiftExit
    // The macOS PR job and local check:native share this entrypoint. Keep the
    // shell packaging/probe regressions here so they cannot silently remain
    // unexecuted while Swift XCTest alone reports the native lane green.
    return await run([
      'bun', 'test', join(root, 'native/cu-helper/build.test.ts'),
    ], { cwd: root, env })
  } finally {
    // A macOS runner occasionally remounts its TMPDIR read-only mid-job, so
    // removal throws EROFS *after* every Swift test has already passed
    // (observed on 2026-09-14 and 2026-09-17). Cleanup is not the signal this
    // lane reports: a failed removal must not turn a green run red. Warn and
    // let the Swift/packaging exit codes above stay authoritative.
    try {
      removeSandbox(sandboxHome)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[swift-checks] could not remove sandbox ${sandboxHome}: ${reason}`)
    }
  }
}

if (import.meta.main) process.exit(await runSwiftChecks())
