import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('source CLI launcher runs through Bun without requiring Bash', async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'cc-haha-cli-launcher-'))
  const repoRoot = path.resolve(import.meta.dir, '..')

  try {
    const child = Bun.spawn(
      [process.execPath, 'run', 'claude-haha', '--version'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CC_HAHA_SKIP_DOTENV: '1',
          CLAUDE_CONFIG_DIR: configDir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('(Claude Code)')
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})
