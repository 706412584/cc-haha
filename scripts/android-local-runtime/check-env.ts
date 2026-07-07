#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type CommandSpec = readonly [command: string, args: string[]]

const commands: CommandSpec[] = [
  ['uname', ['-a']],
  ['uname', ['-m']],
  ['node', ['--version']],
  ['npm', ['--version']],
  ['bun', ['--version']],
  ['git', ['--version']],
  ['python', ['--version']],
  ['pkg', ['--version']],
]

// Android-specific properties. These only exist on real Android/Termux, so
// they are informational: a MISSING result on desktop is expected and never
// blocks the probe.
const androidProps: CommandSpec[] = [
  ['getprop', ['ro.build.version.release']],
  ['getprop', ['ro.product.cpu.abi']],
  ['getprop', ['ro.product.model']],
]

// Storage locations worth recording separately on Android: the repo, Termux
// $HOME, and shared storage behave differently for permissions and symlinks.
const storageChecks: CommandSpec[] = [
  ['df', ['-h', '.']],
]

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
  })

  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n')
    .trim()

  return {
    command: [command, ...args].join(' '),
    ok: result.status === 0,
    status: result.status,
    output,
  }
}

function printResult(result: ReturnType<typeof run>) {
  const marker = result.ok ? 'OK' : 'MISSING'
  console.log(`\n[${marker}] ${result.command}`)
  if (result.output) console.log(result.output)
}

function checkFsRoundTrip() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-haha-android-env-'))
  const file = join(dir, 'probe.txt')
  try {
    writeFileSync(file, 'android-local-runtime-probe')
    const value = readFileSync(file, 'utf8')
    if (value !== 'android-local-runtime-probe') {
      throw new Error(`unexpected content: ${value}`)
    }
    console.log(`\n[OK] fs write/read in ${dir}`)
  } catch (error) {
    console.log(`\n[FAIL] fs write/read in ${dir}`)
    console.log(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('Android local runtime environment probe')
console.log('=======================================')

let missingRequired = false

for (const [command, args] of commands) {
  const result = run(command, args)
  printResult(result)

  if ((command === 'bun' || command === 'git') && !result.ok) {
    missingRequired = true
  }
}

console.log('\nAndroid properties')
console.log('------------------')
for (const [command, args] of androidProps) {
  printResult(run(command, args))
}

console.log('\nStorage and filesystem')
console.log('----------------------')
for (const [command, args] of storageChecks) {
  printResult(run(command, args))
}
checkFsRoundTrip()

console.log('\nNext checks')
console.log('-----------')
console.log('1. Build H5 on a supported desktop first: cd desktop && bun run build')
console.log('2. Start local server: CLAUDE_H5_DIST_DIR=/path/to/desktop/dist bun run src/server/index.ts --host 127.0.0.1 --port 3456')
console.log('3. Verify health: curl http://127.0.0.1:3456/health')
console.log('4. Open H5/WebView at: http://127.0.0.1:3456/')

process.exit(missingRequired ? 1 : 0)
