import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getOriginalCwd,
  setOriginalCwd,
  switchSession,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getLastSessionLog,
  getTranscriptPathForSession,
  recordTranscript,
  resetProjectForTesting,
} from '../sessionStorage.js'
import { resetSettingsCache, setSessionSettingsCache } from '../settings/settingsCache.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const originalCwd = getOriginalCwd()

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
}

const user = (content: string) => ({
  type: 'user' as const,
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
  message: { role: 'user', content },
})

/**
 * A session started in the repo root keeps its transcript in the root's
 * project directory even after the CLI switches into a git worktree — the
 * switch only records `session-meta.workDir`. When the desktop server then
 * spawns the CLI with the worktree as cwd, a cwd-derived transcript lookup
 * finds nothing and resume fails with "No conversation found with session ID".
 * `getLastSessionLog` has to fall back to the sibling worktree roots.
 */
describe('resume from a sibling worktree', () => {
  let tmpDir: string
  let repoDir: string
  let worktreeDir: string
  let sessionId: SessionId

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'session-worktree-resume-'))
    repoDir = path.join(tmpDir, 'repo')
    worktreeDir = path.join(tmpDir, 'repo-wt')
    mkdirSync(repoDir, { recursive: true })
    runGit(repoDir, ['init', '-b', 'main'])
    runGit(repoDir, ['config', 'user.email', 'test@example.com'])
    runGit(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n')
    runGit(repoDir, ['add', '.'])
    runGit(repoDir, ['commit', '-m', 'initial'])
    runGit(repoDir, ['worktree', 'add', '-b', 'wt', worktreeDir])

    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, 'config')
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    setSessionSettingsCache({ settings: { cleanupPeriodDays: 365 }, errors: [] })
    resetProjectForTesting()
    clearSessionMessagesCache()
    sessionId = randomUUID() as SessionId
  })

  afterEach(async () => {
    await flushSessionStorage()
    resetProjectForTesting()
    clearSessionMessagesCache()
    resetSettingsCache()
    setOriginalCwd(originalCwd)
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalTestPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds the transcript when cwd is a sibling worktree of the project that owns it', async () => {
    // Create the session while cwd is the repo root — its transcript lands in
    // the root's project dir.
    setOriginalCwd(repoDir)
    switchSession(sessionId)
    await recordTranscript([user('hello from the repo root')])
    await flushSessionStorage()

    // Resume with cwd = the sibling worktree (what the desktop server does
    // after a mid-session worktree switch).
    resetProjectForTesting()
    clearSessionMessagesCache()
    setOriginalCwd(worktreeDir)
    switchSession(sessionId)

    const log = await getLastSessionLog(sessionId)
    expect(log).not.toBeNull()
    expect(log?.messages.some(m => m.type === 'user')).toBe(true)
    // fullPath must name the file that was actually read (the repo root's
    // copy), because resume switches the active project dir to its dirname —
    // a cwd-derived guess would send the resumed session's new messages into
    // the worktree's project dir instead.
    expect(log?.fullPath?.endsWith(`${sessionId}.jsonl`)).toBe(true)
    expect(log?.fullPath).not.toContain('repo-wt')
  })

  it('skips a truncated zero-byte copy and reads the valid sibling', async () => {
    // Create the session at the repo root, then simulate the failure mode a
    // crashed write leaves behind: a zero-byte file in the cwd-derived
    // project dir must not shadow the valid transcript elsewhere.
    setOriginalCwd(repoDir)
    switchSession(sessionId)
    await recordTranscript([user('the valid copy')])
    await flushSessionStorage()
    const realPath = getTranscriptPathForSession(sessionId)

    // Resume from the worktree, with a truncated decoy in its project dir.
    resetProjectForTesting()
    clearSessionMessagesCache()
    setOriginalCwd(worktreeDir)
    switchSession(sessionId)
    const decoyDir = path.dirname(getTranscriptPathForSession(sessionId))
    mkdirSync(decoyDir, { recursive: true })
    writeFileSync(path.join(decoyDir, `${sessionId}.jsonl`), '')

    const log = await getLastSessionLog(sessionId)
    expect(log).not.toBeNull()
    expect(log?.messages.some(m => m.type === 'user')).toBe(true)
    expect(log?.fullPath).toBe(realPath)
  })

  it('still returns null for a session that exists nowhere', async () => {
    setOriginalCwd(worktreeDir)
    switchSession(sessionId)
    expect(await getLastSessionLog(sessionId)).toBeNull()
  })
})
