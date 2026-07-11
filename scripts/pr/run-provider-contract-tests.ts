#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootBunTestFilter } from './bun-test-filter'
import { createSandboxedTestEnvironment } from './test-environment'

const root = join(import.meta.dir, '..', '..')
// Keep this lane deterministic. Real credentials and third-party connectivity
// belong to the trusted provider-smoke lanes, never to external PR checks.
const testFiles = [
  'src/server/__tests__/provider-settings-isolation.test.ts',
  'src/server/__tests__/provider-presets.test.ts',
  'src/server/__tests__/provider-runtime-env.test.ts',
  'src/services/api/client.test.ts',
  'src/services/compact/autoCompact.test.ts',
  'src/services/openaiAuth/client.test.ts',
  'src/services/openaiAuth/fetch.test.ts',
  'src/services/openaiAuth/models.test.ts',
  'src/services/openaiAuth/storage.test.ts',
  'src/utils/__tests__/providerManagedEnvCompat.test.ts',
  'src/utils/managedEnv.test.ts',
  'src/utils/model/modelContextWindows.test.ts',
  'src/server/__tests__/providers.test.ts',
  'src/server/__tests__/proxy-transform.test.ts',
  'src/server/__tests__/proxy-streaming.test.ts',
  'src/server/__tests__/network-settings.test.ts',
  'src/server/__tests__/proxy-network-settings.test.ts',
  'src/utils/proxy.test.ts',
]

for (const testFile of testFiles) {
  console.log(`\n[provider-contract] ${testFile}`)
  const sandboxHome = mkdtempSync(join(tmpdir(), 'cc-haha-provider-contract-'))
  let exitCode = 1
  try {
    const proc = Bun.spawn([
      'bun',
      '--no-env-file',
      'test',
      rootBunTestFilter(testFile),
    ], {
      cwd: root,
      env: createSandboxedTestEnvironment(sandboxHome),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    exitCode = await proc.exited
  } finally {
    rmSync(sandboxHome, { recursive: true, force: true })
  }
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

console.log(`\n[provider-contract] ${testFiles.length} deterministic suites passed`)
