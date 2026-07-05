#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'

const commands = [
  ['uname', ['-a']],
  ['node', ['--version']],
  ['npm', ['--version']],
  ['bun', ['--version']],
  ['git', ['--version']],
  ['python', ['--version']],
  ['pkg', ['--version']],
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

console.log('Android local runtime environment probe')
console.log('=======================================')

let missingRequired = false

for (const [command, args] of commands) {
  const result = run(command, args)
  const marker = result.ok ? 'OK' : 'MISSING'
  console.log(`\n[${marker}] ${result.command}`)
  if (result.output) console.log(result.output)

  if ((command === 'bun' || command === 'git') && !result.ok) {
    missingRequired = true
  }
}

console.log('\nNext checks')
console.log('-----------')
console.log('1. Build H5 on a supported desktop first: cd desktop && bun run build')
console.log('2. Start local server: CLAUDE_H5_DIST_DIR=/path/to/desktop/dist bun run src/server/index.ts --host 127.0.0.1 --port 3456')
console.log('3. Verify health: curl http://127.0.0.1:3456/health')
console.log('4. Open H5/WebView at: http://127.0.0.1:3456/')

process.exit(missingRequired ? 1 : 0)
