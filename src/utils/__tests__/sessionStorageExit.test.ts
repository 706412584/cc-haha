import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

// Exercise the registered runtime shutdown callback in another process. That
// process caches enabled settings and never observes the parent's 365→0→365.
for (const deleted of [true, false]) {
  test(`runtime exit ${deleted ? 'does not recreate a deleted transcript' : 'preserves metadata for an existing transcript'}`, async () => {
    const directory = await mkdtemp('/tmp/session-exit-retention-')
    const env = createSandboxedTestEnvironment(directory, { TEST_ENABLE_SESSION_PERSISTENCE: '1' })
    const configDir = env.CLAUDE_CONFIG_DIR!
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }))
    const source = `
      import { mkdir } from 'node:fs/promises'
      import { switchSession } from './src/bootstrap/state.ts'
      import { getSettings_DEPRECATED } from './src/utils/settings/settings.ts'
      import { runCleanupFunctions } from './src/utils/cleanupRegistry.ts'
      import { cacheSessionTitle, flushSessionStorage, getTranscriptPathForSession, recordTranscript } from './src/utils/sessionStorage.ts'
      const id = 'deadbeef-0000-4000-8000-000000000001'
      switchSession(id)
      await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
      getSettings_DEPRECATED()
      cacheSessionTitle('CACHED EXIT TITLE')
      await recordTranscript([{type:'user', uuid:'deadbeef-0000-4000-8000-000000000002', timestamp:'2026-09-10T00:00:00.000Z', message:{role:'user',content:'CACHED EXIT PRIVATE PROMPT'}}])
      await flushSessionStorage()
      process.stdout.write(JSON.stringify({ path: getTranscriptPathForSession(id) }) + '\\n')
      await new Promise(resolve => process.stdin.once('data', resolve))
      // This is the same cleanup registry invoked by gracefulShutdown.
      await runCleanupFunctions()
      process.exit(0)
    `
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', source], {
      cwd: join(import.meta.dir, '../../..'), env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    const errorOutput = new Response(child.stderr).text()
    try {
      const reader = child.stdout.getReader()
      let ready = ''
      while (!ready.includes('\n')) {
        const result = await reader.read()
        if (result.done) throw new Error(`Runtime exited before ready: ${await errorOutput}`)
        ready += new TextDecoder().decode(result.value)
      }
      const { path } = JSON.parse(ready.trim()) as { path: string }
      const initial = await readFile(path, 'utf8')
      expect(initial).toContain('CACHED EXIT PRIVATE PROMPT')
      expect(initial).toContain('CACHED EXIT TITLE')
      expect(initial).not.toContain('last-prompt')
      if (deleted) {
        await writeFile(join(configDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 0 }))
        await unlink(path)
        await writeFile(join(configDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }))
      }
      child.stdin.write('exit\n')
      child.stdin.end()
      expect(await child.exited).toBe(0)
      expect(await errorOutput).toBe('')
      if (deleted) {
        expect(await readFile(path, 'utf8').catch(() => null)).toBeNull()
      } else {
        const final = await readFile(path, 'utf8')
        expect(final).toContain('"lastPrompt":"CACHED EXIT PRIVATE PROMPT"')
        expect(final.match(/CACHED EXIT TITLE/g)).toHaveLength(2)
      }
    } finally {
      child.kill()
      await child.exited
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
}
