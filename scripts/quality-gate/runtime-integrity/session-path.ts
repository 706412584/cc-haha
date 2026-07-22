import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionService } from '../../../src/server/services/sessionService.js'
import type {
  IndexedSessionRow,
  LocalIndexGateway,
  SessionFileMatch,
  SessionIndexPage,
} from '../../../src/server/services/localIndex/sessionIndex.js'
import type {
  LocalIndexMode,
  LocalIndexStatus,
} from '../../../src/server/services/localIndex/types.js'

class SmokeIndexGateway implements LocalIndexGateway {
  mode: LocalIndexMode = 'off'
  ready = false
  status: LocalIndexStatus = {
    mode: 'off',
    state: 'off',
    discovered: 0,
    indexed: 0,
    degradedSources: 0,
    databaseBytes: 0,
    walBytes: 0,
    lastUpdatedAt: null,
    lastErrorCode: null,
  }
  page: SessionIndexPage = { sessions: [], total: 0 }
  matches: SessionFileMatch[] = []

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async rebuild(): Promise<LocalIndexStatus> { return this.status }
  getMode(): LocalIndexMode { return this.mode }
  getPublicStatus(): LocalIndexStatus { return { ...this.status, mode: this.mode } }
  isSessionScopeReady(): boolean { return this.ready }
  listSessions(): SessionIndexPage { return this.page }
  findSessionFiles(): SessionFileMatch[] { return this.matches }
}

const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-session-path-config-'))
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-session-path-work-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

try {
  const sessionId = randomUUID()
  const projectDir = '-runtime-integrity-session-path'
  const transcriptDir = path.join(configDir, 'projects', projectDir)
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`)
  const timestamp = new Date().toISOString()
  await fs.mkdir(transcriptDir, { recursive: true })
  await fs.writeFile(transcriptPath, `${JSON.stringify({
    type: 'user',
    uuid: randomUUID(),
    sessionId,
    cwd: workDir,
    timestamp,
    message: { role: 'user', content: 'session path smoke' },
  })}\n`)
  const canonicalPath = await fs.realpath(transcriptPath)

  const offGateway = new SmokeIndexGateway()
  const offList = await new SessionService(offGateway).listSessions()

  const degradedGateway = new SmokeIndexGateway()
  degradedGateway.mode = 'on'
  degradedGateway.ready = true
  degradedGateway.status = {
    ...degradedGateway.status,
    mode: 'on',
    state: 'degraded',
    degradedSources: 1,
    lastErrorCode: 'LOCAL_INDEX_READ_FAILED',
  }
  const degradedList = await new SessionService(degradedGateway).listSessions()

  const row: IndexedSessionRow = {
    transcriptPath: canonicalPath,
    id: sessionId,
    title: 'session path smoke',
    createdAt: timestamp,
    modifiedAt: timestamp,
    messageCount: 1,
    projectPath: projectDir,
    workDir,
  }
  const indexedGateway = new SmokeIndexGateway()
  indexedGateway.mode = 'on'
  indexedGateway.ready = true
  indexedGateway.status = {
    ...indexedGateway.status,
    mode: 'on',
    state: 'ready',
    discovered: 1,
    indexed: 1,
    lastUpdatedAt: timestamp,
  }
  indexedGateway.page = { sessions: [row], total: 1 }
  indexedGateway.matches = [{ filePath: canonicalPath, projectDir }]
  const indexedService = new SessionService(indexedGateway)
  const indexedList = await indexedService.listSessions()
  const detail = await indexedService.getSession(sessionId)

  const observed = {
    off: offList.sessions.find((session) => session.id === sessionId)?.filePath,
    degraded: degradedList.sessions.find((session) => session.id === sessionId)?.filePath,
    indexed: indexedList.sessions.find((session) => session.id === sessionId)?.filePath,
    detail: detail?.filePath,
  }
  for (const [mode, filePath] of Object.entries(observed)) {
    if (!filePath) throw new Error(`${mode} did not return filePath`)
    if (await fs.realpath(filePath) !== canonicalPath) {
      throw new Error(`${mode} returned a non-canonical transcript path`)
    }
    if (!(await fs.stat(filePath)).isFile()) {
      throw new Error(`${mode} returned a path that is not a file`)
    }
  }

  console.log(JSON.stringify({
    passed: true,
    sessionId,
    canonicalPath,
    observed,
  }, null, 2))
} finally {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(configDir, { recursive: true, force: true })
  await fs.rm(workDir, { recursive: true, force: true })
}
