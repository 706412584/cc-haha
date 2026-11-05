import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './sessionService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { HISTORY_SEMANTIC_RECORD_BYTES } from './boundedSessionHistory.js'

const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
let directory: string
let file: string
let oldHome: string | undefined
let oldConfig: string | undefined
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'session-metadata-'))
  oldHome = process.env.HOME
  oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = directory
  resetSettingsCache()
  const project = join(directory, 'projects', sanitizePath(directory))
  await mkdir(project, { recursive: true })
  file = join(project, `${sessionId}.jsonl`)
})
afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME
  else process.env.HOME = oldHome
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = oldConfig
  resetSettingsCache()
  await rm(directory, { recursive: true, force: true })
})
const body = 'x'.repeat(HISTORY_SEMANTIC_RECORD_BYTES + 1)
async function seed(entries: unknown[]) {
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
}

test('cold session metadata and restart survive a large image and retain the latest runtime selection', async () => {
  await seed([
    { type: 'session-meta', workDir: directory, runtimeProviderId: 'old', runtimeModelId: 'old', effortLevel: 'high' },
    { type: 'user', cwd: directory, message: { role: 'user', content: [{ type: 'image', source: { data: body } }, { type: 'text', text: 'Image task' }] } },
    { type: 'session-meta', workDir: directory, runtimeProviderId: 'new', runtimeModelId: 'new' },
  ])
  const before = await readFile(file)
  for (let restart = 0; restart < 2; restart++) {
    const service = new SessionService()
    expect(await service.getSessionWorkDir(sessionId)).toBe(directory)
    expect(await service.getSessionLaunchInfo(sessionId)).toMatchObject({ workDir: directory, transcriptMessageCount: 1, runtimeProviderId: 'new', runtimeModelId: 'new' })
    expect((await service.getSessionLaunchInfo(sessionId))?.effortLevel).toBeUndefined()
  }
  expect(await readFile(file)).toEqual(before)
})

test('a sole oversized legacy turn remains resumable and cannot be mistaken for an empty placeholder', async () => {
  await seed([{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: body } }] }, cwd: directory, repository: { repoName: 'fixture', projectRoot: directory } }])
  const info = await new SessionService().getSessionLaunchInfo(sessionId)
  expect(info).toMatchObject({ transcriptMessageCount: 1, workDir: directory, repository: { repoName: 'fixture', projectRoot: directory } })
})

test('large bodies preserve system turn counts, isMeta exclusion, and explicit worktree clearing', async () => {
  await seed([
    { type: 'worktree-state', worktreeSession: { worktreePath: '/fixture/worktree', worktreeName: 'fixture' } },
    { type: 'system', message: { role: 'system', content: body }, cwd: directory },
    { type: 'user', isMeta: true, message: { role: 'user', content: body } },
    { type: 'worktree-state', worktreeSession: null },
  ])
  expect(await new SessionService().getSessionLaunchInfo(sessionId)).toMatchObject({ transcriptMessageCount: 1, workDir: directory, worktreeSession: null })
})

test('actual over-budget launch metadata still blocks unsafe launch', async () => {
  await seed([{ type: 'session-meta', workDir: body }])
  await expect(new SessionService().getSessionLaunchInfo(sessionId)).rejects.toMatchObject({ code: 'SESSION_METADATA_TOO_LARGE' })
})

test('inspection snapshots stay cached across sessions and follow an append incrementally', async () => {
  // An append changes the transcript's stat signature. Keying the snapshot map by
  // that signature meant every poll of an active conversation was a miss, and its
  // entries evicted every other open session (measured ~3.9s per round for twelve
  // sessions). The map is keyed by transcript now, with the signature checked on
  // hit, so a repeat poll of the same file is free and an append folds only the
  // new bytes.
  const entry = (content: string) => ({
    type: 'user', cwd: directory, timestamp: '2026-07-15T00:00:00.000Z',
    message: { role: 'user', content },
  })
  await seed([entry('first')])
  const service = new SessionService()
  const internals = service as unknown as {
    readInspectionSnapshotForSession: (sessionId: string, filePath: string) => Promise<unknown>
    inspectionSnapshots: Map<string, { signature: string }>
  }

  const first = await service.getInspectionTranscriptSnapshot(sessionId)
  expect(first).not.toBeNull()
  const reads = await Promise.all([
    service.getInspectionTranscriptSnapshot(sessionId),
    service.getInspectionTranscriptSnapshot(sessionId),
  ])
  expect(reads[0]).toBe(first)
  expect(internals.inspectionSnapshots.size).toBe(1)

  // Appending invalidates the snapshot, but the fold resumes from its offset
  // rather than re-reading the transcript.
  await writeFile(file, [entry('first'), entry('second')].map(value => JSON.stringify(value)).join('\n') + '\n')
  const after = await service.getInspectionTranscriptSnapshot(sessionId)
  expect(after).not.toBe(first)
  expect(after?.launchInfo.transcriptMessageCount).toBe(2)
  expect(internals.inspectionSnapshots.size).toBe(1)
})

test('inspection snapshots keep every open session instead of evicting the oldest', async () => {
  const entry = { type: 'user', cwd: directory, timestamp: '2026-07-15T00:00:00.000Z', message: { role: 'user', content: 'x' } }
  const service = new SessionService()
  const internals = service as unknown as { inspectionSnapshots: Map<string, unknown> }
  // Twelve sessions is what a user plausibly keeps open; the old cap of 8
  // evicted the oldest before their next poll.
  const project = join(directory, 'projects', sanitizePath(directory))
  await mkdir(project, { recursive: true })
  const sessions = Array.from({ length: 12 }, (_, index) => `00000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`)
  for (const id of sessions) {
    await writeFile(join(project, `${id}.jsonl`), JSON.stringify(entry) + '\n')
    expect(await service.getInspectionTranscriptSnapshot(id)).not.toBeNull()
  }
  expect(internals.inspectionSnapshots.size).toBe(sessions.length)
})
