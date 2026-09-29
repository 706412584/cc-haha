import { expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../../scripts/pr/test-environment.js'

test('an existing session with a large image opens checkpoint metadata and resumes without losing its history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oversized-session-e2e-'))
  const original = { ...process.env }
  const env = createSandboxedTestEnvironment(home, {
    CLAUDE_CLI_PATH: fileURLToPath(new URL('../fixtures/mock-sdk-cli.ts', import.meta.url)),
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  let server: ReturnType<typeof Bun.serve> | undefined
  let shutdown: (() => Promise<void>) | undefined
  let socket: WebSocket | undefined
  try {
    const workDir = join(home, 'project')
    await mkdir(workDir)
    const runtime = await import('../../index.js')
    const { sessionService } = await import('../../services/sessionService.js')
    shutdown = runtime.stopServerRuntimeForShutdown
    server = runtime.startServer(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`
    const created = await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workDir }),
    })
    expect(created.status).toBe(201)
    const { sessionId } = await created.json() as { sessionId: string }
    const initial = await sessionService.getSessionLaunchInfo(sessionId)
    const image = {
      uuid: crypto.randomUUID(), type: 'user', cwd: workDir, sessionId,
      timestamp: '2026-09-27T01:00:00Z',
      message: { role: 'user', content: [
        { type: 'text', text: 'Inspect this large image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(9 * 1024 * 1024) } },
      ] },
    }
    await appendFile(initial!.filePath, [
      { uuid: crypto.randomUUID(), type: 'user', cwd: workDir, message: { role: 'user', content: 'Earlier request' } },
      { uuid: crypto.randomUUID(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier completed reply' }] } },
      image,
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const before = await readFile(initial!.filePath, 'utf8')

    // This is fetched automatically by the desktop when opening a completed
    // conversation. It used to surface the screenshot's red metadata error.
    const checkpoint = await fetch(`${base}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(checkpoint.status).toBe(200)
    expect((await checkpoint.json() as { checkpoints: unknown[] }).checkpoints).toHaveLength(1)
    expect((await sessionService.getSessionLaunchInfo(sessionId))?.transcriptMessageCount).toBe(3)

    const events: Record<string, unknown>[] = []
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${sessionId}`)
    socket.onmessage = event => events.push(JSON.parse(String(event.data)))
    async function until(predicate: () => boolean) {
      const deadline = Date.now() + 10_000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Session did not recover: ${JSON.stringify(events)}`)
        await Bun.sleep(20)
      }
    }
    await until(() => events.some(event => event.type === 'connected'))
    socket.send(JSON.stringify({ type: 'user_message', content: 'continue after the large image' }))
    await until(() => events.some(event => event.type === 'message_complete'))
    expect(events.filter(event => event.type === 'error')).toEqual([])
    expect(JSON.stringify(events)).toContain('Echo: continue after the large image')
    // A large first turn must never be mistaken for a metadata-only placeholder
    // and cleared by startup. Only new metadata may be appended.
    expect((await readFile(initial!.filePath, 'utf8')).startsWith(before)).toBe(true)

    await appendFile(initial!.filePath, JSON.stringify({
      uuid: crypto.randomUUID(), type: 'assistant', timestamp: '2026-09-27T01:01:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Visible reply after the large image' }] },
    }) + '\n')
    const history = await fetch(`${base}/api/sessions/${sessionId}/messages`)
    expect(history.status).toBe(200)
    expect(JSON.stringify(await history.json())).toContain('Visible reply after the large image')
  } finally {
    socket?.close()
    await shutdown?.()
    server?.stop(true)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
