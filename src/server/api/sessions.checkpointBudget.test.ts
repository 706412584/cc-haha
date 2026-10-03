import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const checkpointBudget = 16 * 1024 * 1024
const originalEnvironment = { ...process.env }
let sandbox: string
let workDir: string
let configDir: string
let handleSessionsApi: typeof import('./sessions.js').handleSessionsApi

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'qa-005-checkpoint-budget-'))
  const environment = createSandboxedTestEnvironment(sandbox, {
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
  configDir = environment.CLAUDE_CONFIG_DIR!
  workDir = join(sandbox, 'workspace')
  await mkdir(workDir)
  await mkdir(join(configDir, 'projects', 'fixture'), { recursive: true })
  handleSessionsApi = (await import('./sessions.js')).handleSessionsApi
})

afterAll(async () => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
  await rm(sandbox, { recursive: true, force: true })
})

function row(type: string, content: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    uuid: crypto.randomUUID(), type, cwd: workDir,
    timestamp: '2026-10-01T08:00:00.000Z',
    message: { role: type, content }, ...extra,
  }) + '\n'
}

async function createTranscript(content: string, activityCount = 0, totalBytes?: number) {
  const sessionId = crypto.randomUUID()
  const filePath = join(configDir, 'projects', 'fixture', `${sessionId}.jsonl`)
  const changedPath = join(workDir, `${sessionId}.txt`)
  const entries = [row('user', 'Synthetic history replay; inspect the file')]
  // Like the QA fixture, these are completed Agent records below the per-record
  // budget. Their cumulative activity is allowed to overflow recovery while the
  // small Write remains complete. This never invokes an agent or provider.
  for (let index = 0; index < activityCount; index++) {
    entries.push(row('assistant', [{ type: 'tool_use', id: `agent-${index}`, name: 'Agent', input: {
      description: 'a'.repeat(10 * 1024), subagent_type: 'general-purpose',
    } }]))
    entries.push(row('user', [{ type: 'tool_result', tool_use_id: `agent-${index}`, content: 'Synthetic completed result' }]))
  }
  entries.push(row('assistant', [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: changedPath, content } }]))
  entries.push(row('user', [{ type: 'tool_result', tool_use_id: 'write', content: 'Created successfully' }]))
  entries.push(row('assistant', [{ type: 'text', text: 'Synthetic replay complete' }]))
  if (totalBytes !== undefined) {
    let remaining = totalBytes - Buffer.byteLength(entries.join(''))
    const overhead = Buffer.byteLength(JSON.stringify({ type: 'progress', padding: '' }) + '\n')
    while (remaining > 0) {
      const bytes = Math.min(60 * 1024, remaining)
      if (bytes < overhead) throw new Error('Invalid fixture padding')
      entries.push(JSON.stringify({ type: 'progress', padding: 'x'.repeat(bytes - overhead) }) + '\n')
      remaining -= bytes
    }
  }
  const transcript = entries.join('')
  await writeFile(filePath, transcript)
  await writeFile(changedPath, content)
  return { sessionId, fileName: `${sessionId}.txt`, bytes: Buffer.byteLength(transcript) }
}

async function get(sessionId: string, resource: string) {
  const request = new Request(`http://localhost/api/sessions/${sessionId}/${resource}`)
  const url = new URL(request.url)
  return handleSessionsApi(request, url, url.pathname.split('/').filter(Boolean))
}

test('QA-005 keeps the full checkpoint limit while retaining bounded workspace files after activity overflow', async () => {
  const fixture = await createTranscript('QA retained workspace evidence\n', 2050)
  expect(fixture.bytes).toBeGreaterThan(checkpointBudget)
  const checkpoints = await get(fixture.sessionId, 'turn-checkpoints')
  expect(checkpoints.status).toBe(413)
  expect(await checkpoints.json()).toMatchObject({ error: 'HISTORY_CHECKPOINT_PREVIEW_LIMIT' })
  const workspace = await get(fixture.sessionId, 'workspace/status')
  expect(workspace.status).toBe(200)
  expect(await workspace.json()).toMatchObject({
    state: 'ok', isGitRepo: false,
    changedFiles: [{ path: fixture.fileName, status: 'added', additions: 1, deletions: 0 }],
  })
  const file = await get(fixture.sessionId, `workspace/file?path=${fixture.fileName}`)
  expect(file.status).toBe(200)
  expect(await file.json()).toMatchObject({ state: 'ok', content: 'QA retained workspace evidence\n' })
  // A current-content preview is safe; a claimed turn baseline still requires
  // the full checkpoint evidence and must not sneak past its original budget.
  expect((await get(fixture.sessionId, `turn-checkpoints/diff?userMessageIndex=0&path=${fixture.fileName}`)).status).toBe(413)
}, 20_000)

test('QA-005 oversized Write remains conservative even though the current file is readable', async () => {
  const fixture = await createTranscript('x'.repeat(128 * 1024), 2050)
  const workspace = await get(fixture.sessionId, 'workspace/status')
  expect(workspace.status).toBe(413)
  expect(await workspace.json()).toMatchObject({ error: 'HISTORY_WORKSPACE_LIMIT' })
  const file = await get(fixture.sessionId, `workspace/file?path=${fixture.fileName}`)
  expect(file.status).toBe(200)
  expect(await file.json()).toMatchObject({ state: 'ok', size: 128 * 1024 })
  const checkpoints = await get(fixture.sessionId, 'turn-checkpoints')
  expect(checkpoints.status).toBe(413)
  expect(await checkpoints.json()).toMatchObject({ error: 'HISTORY_CHECKPOINT_PREVIEW_LIMIT' })
}, 20_000)

test('QA-005 full checkpoint preview admits exactly 16MiB and rejects the next byte', async () => {
  const admitted = await createTranscript('boundary\n', 0, checkpointBudget)
  expect(admitted.bytes).toBe(checkpointBudget)
  const checkpoints = await get(admitted.sessionId, 'turn-checkpoints')
  expect(checkpoints.status).toBe(200)
  const body = await checkpoints.json() as { checkpoints: Array<{ code: { filesChanged: string[] } }> }
  expect(body.checkpoints[0]?.code.filesChanged).toContain(join(workDir, admitted.fileName))
  const rejected = await createTranscript('boundary\n', 0, checkpointBudget + 1)
  expect(rejected.bytes).toBe(checkpointBudget + 1)
  const response = await get(rejected.sessionId, 'turn-checkpoints')
  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ error: 'HISTORY_CHECKPOINT_PREVIEW_LIMIT' })
}, 20_000)
