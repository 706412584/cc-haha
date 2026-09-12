#!/usr/bin/env bun

type Check = {
  title: string
  command: string[]
  cwd?: string
}

const rootDir = process.cwd()
const checks: Check[] = [
  {
    title: 'Local index schema compatibility after protocol rollback',
    command: [
      'bun', 'test', './src/server/services/localIndex/database.test.ts',
      // v6: the merge moved upstream's v5 api-format migration to v6 (the
      // fork lineage already owns v5 for thinking_enabled), so the frozen
      // rollback test renamed accordingly.
      '--test-name-pattern', 'frozen v[456]',
    ],
  },
  {
    title: 'Server persistent JSON migrations',
    command: ['bun', 'test', './src/server/__tests__/persistence-upgrade.test.ts'],
  },
  {
    title: 'Desktop UI preference migrations',
    command: [
      'bun',
      'test',
      './src/server/__tests__/desktop-ui-preferences.test.ts',
      '--test-name-pattern',
      'normalizes old schema files',
    ],
  },
  {
    title: 'Desktop localStorage migrations',
    command: ['bun', 'run', 'test', '--', '--run', 'src/lib/persistenceMigrations.test.ts'],
    cwd: 'desktop',
  },
]

async function runCheck(check: Check): Promise<number> {
  const cwd = check.cwd ? `${rootDir}/${check.cwd}` : rootDir
  console.log(`\n[persistence-upgrade] ${check.title}`)
  console.log(`$ ${check.command.join(' ')}`)
  const proc = Bun.spawn(check.command, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return proc.exited
}

let failures = 0
for (const check of checks) {
  const code = await runCheck(check)
  if (code !== 0) {
    failures += 1
  }
}

if (failures > 0) {
  console.error(`\n[persistence-upgrade] failed checks: ${failures}`)
  process.exit(1)
}

console.log('\n[persistence-upgrade] all checks passed')
