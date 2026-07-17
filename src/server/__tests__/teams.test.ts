/**
 * Unit tests for TeamService and Teams API
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { TeamService } from '../services/teamService.js'
import {
  captureSourceFingerprint,
  serializeSourceFingerprint,
} from '../services/localIndex/sourceFingerprint.js'
import { readSessionEntriesByLocator } from '../services/localIndex/sessionEntries.js'
import type {
  LocalIndexGateway,
  SessionEntryLocatorPage,
} from '../services/localIndex/sessionIndex.js'

// ============================================================================
// Test helpers
// ============================================================================

let tmpDir: string
let service: TeamService

async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(
    os.tmpdir(),
    `claude-teams-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(path.join(tmpDir, 'teams'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  return tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
}

/** Write a team config.json to the temp directory. */
async function writeTeamConfig(
  teamName: string,
  config: Record<string, unknown>,
): Promise<string> {
  const teamDir = path.join(tmpDir, 'teams', teamName)
  await fs.mkdir(teamDir, { recursive: true })
  const configPath = path.join(teamDir, 'config.json')
  await fs.writeFile(configPath, JSON.stringify(config), 'utf-8')
  return configPath
}

/** Write a mock JSONL transcript file under projects. */
async function writeTranscriptFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

async function writeSubagentTranscriptFile(
  projectDir: string,
  leadSessionId: string,
  fileName: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir, leadSessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, fileName)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

/** Create a standard team config for testing. */
function makeTeamConfig(overrides?: Record<string, unknown>) {
  return {
    name: 'test-team',
    description: 'A test team',
    createdAt: 1700000000000,
    leadAgentId: 'agent-lead',
    members: [
      {
        agentId: 'agent-lead',
        name: 'Lead Agent',
        agentType: 'lead',
        model: 'claude-opus-4-7',
        color: '#ff0000',
        joinedAt: 1700000000000,
        tmuxPaneId: '%0',
        cwd: '/tmp/project',
        sessionId: 'session-lead-001',
        isActive: true,
      },
      {
        agentId: 'agent-worker',
        name: 'Worker Agent',
        agentType: 'worker',
        model: 'claude-sonnet-4-20250514',
        color: '#00ff00',
        joinedAt: 1700000001000,
        tmuxPaneId: '%1',
        cwd: '/tmp/project/src',
        sessionId: 'session-worker-001',
        isActive: false,
      },
    ],
    ...overrides,
  }
}

function disabledIndexGateway(): LocalIndexGateway {
  return {
    async start() {},
    async stop() {},
    getMode: () => 'off',
    getPublicStatus: () => ({
      mode: 'off',
      state: 'off',
      discovered: 0,
      indexed: 0,
      degradedSources: 0,
      databaseBytes: 0,
      walBytes: 0,
      lastUpdatedAt: null,
      lastErrorCode: null,
    }),
    isSessionScopeReady: () => false,
    listSessions: () => ({ sessions: [], total: 0 }),
    findSessionFiles: () => [],
    async rebuild() { return this.getPublicStatus() },
  }
}

// ============================================================================
// TeamService tests
// ============================================================================

describe('TeamService', () => {
  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new TeamService()
  })

  afterEach(async () => {
    await cleanupTmpDir()
  })

  // --------------------------------------------------------------------------
  // listTeams
  // --------------------------------------------------------------------------

  it('should return empty list when no teams exist', async () => {
    const teams = await service.listTeams()
    expect(teams).toEqual([])
  })

  it('should return empty list when teams directory does not exist', async () => {
    await fs.rm(path.join(tmpDir, 'teams'), { recursive: true, force: true })
    const teams = await service.listTeams()
    expect(teams).toEqual([])
  })

  it('should list teams from config files', async () => {
    await writeTeamConfig('alpha', makeTeamConfig({ name: 'alpha' }))
    await writeTeamConfig('beta', makeTeamConfig({ name: 'beta', description: 'Beta team' }))

    const teams = await service.listTeams()
    expect(teams).toHaveLength(2)

    const names = teams.map((t) => t.name).sort()
    expect(names).toEqual(['alpha', 'beta'])
  })

  it('should compute memberCount and activeMemberCount', async () => {
    await writeTeamConfig('gamma', makeTeamConfig({ name: 'gamma' }))

    const teams = await service.listTeams()
    expect(teams).toHaveLength(1)
    expect(teams[0]!.memberCount).toBe(2)
    expect(teams[0]!.activeMemberCount).toBe(1) // only lead is active
  })

  it('should skip malformed team directories', async () => {
    // Create a team dir with invalid JSON
    const badDir = path.join(tmpDir, 'teams', 'bad-team')
    await fs.mkdir(badDir, { recursive: true })
    await fs.writeFile(path.join(badDir, 'config.json'), 'not json', 'utf-8')

    // Also create a valid team
    await writeTeamConfig('good-team', makeTeamConfig({ name: 'good-team' }))

    const teams = await service.listTeams()
    expect(teams).toHaveLength(1)
    expect(teams[0]!.name).toBe('good-team')
  })

  // --------------------------------------------------------------------------
  // getTeam
  // --------------------------------------------------------------------------

  it('should return team detail with members', async () => {
    await writeTeamConfig(
      'detail-team',
      makeTeamConfig({
        name: 'detail-team',
        leadSessionId: 'lead-session-xyz',
      }),
    )

    const detail = await service.getTeam('detail-team')
    expect(detail.name).toBe('detail-team')
    expect(detail.leadAgentId).toBe('agent-lead')
    expect(detail.leadSessionId).toBe('lead-session-xyz')
    expect(detail.members).toHaveLength(2)
    expect(detail.members[0]!.agentId).toBe('agent-lead')
    expect(detail.members[1]!.agentId).toBe('agent-worker')
  })

  it('should discover missing in-process members from subagent transcripts', async () => {
    await writeTeamConfig(
      'subagent-team',
      makeTeamConfig({
        name: 'subagent-team',
        leadSessionId: 'lead-session-subagents',
        members: [
          {
            agentId: 'agent-lead',
            name: 'Lead Agent',
            agentType: 'lead',
            joinedAt: 1700000000000,
            tmuxPaneId: '%0',
            cwd: '/tmp/project',
            sessionId: 'session-lead-001',
            isActive: true,
          },
        ],
      }),
    )

    await writeSubagentTranscriptFile(
      '-tmp-project',
      'lead-session-subagents',
      'agent-1.jsonl',
      [
        {
          agentName: 'security-reviewer',
          agentId: 'security-reviewer@subagent-team',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    )

    const detail = await service.getTeam('subagent-team')
    expect(detail.members.some((member) => member.name === 'security-reviewer')).toBe(true)
  })

  it('should derive running status for active member', async () => {
    await writeTeamConfig('status-team', makeTeamConfig({ name: 'status-team' }))

    const detail = await service.getTeam('status-team')
    const lead = detail.members.find((m) => m.agentId === 'agent-lead')!
    expect(lead.status).toBe('running')
  })

  it('should derive idle status for inactive member', async () => {
    await writeTeamConfig('status-team', makeTeamConfig({ name: 'status-team' }))

    const detail = await service.getTeam('status-team')
    const worker = detail.members.find((m) => m.agentId === 'agent-worker')!
    expect(worker.status).toBe('idle')
  })

  it('should derive running status when isActive is undefined', async () => {
    const config = makeTeamConfig({ name: 'undef-team' })
    // Remove isActive from the first member to simulate undefined
    delete (config.members[0] as Record<string, unknown>).isActive
    await writeTeamConfig('undef-team', config)

    const detail = await service.getTeam('undef-team')
    const lead = detail.members.find((m) => m.agentId === 'agent-lead')!
    expect(lead.status).toBe('running')
  })

  it('should throw 404 for non-existent team', async () => {
    expect(service.getTeam('nonexistent')).rejects.toThrow('Team not found')
  })

  // --------------------------------------------------------------------------
  // getMemberTranscript
  // --------------------------------------------------------------------------

  it('uses the session index locator and bounded entry ranges for a configured session', async () => {
    await writeTeamConfig('indexed-team', makeTeamConfig({ name: 'indexed-team' }))
    const filePath = await writeTranscriptFile('-tmp-project', 'session-lead-001', [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'Indexed' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }])
    const stat = await fs.stat(filePath)
    const fingerprint = serializeSourceFingerprint({
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      fileIdentity: null,
      firstWindowHash: 'a'.repeat(64),
      lastWindowHash: 'b'.repeat(64),
      boundaryWindowHash: 'c'.repeat(64),
      indexedBytes: stat.size,
      parserVersion: 3,
    })
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => 'on',
      getPublicStatus: () => ({ mode: 'on', state: 'ready', discovered: 1, indexed: 1, degradedSources: 0, databaseBytes: 1, walBytes: 0, lastUpdatedAt: 'now', lastErrorCode: null }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      getSessionEntryLocators: () => ({
        source: { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, fileIdentity: null, fingerprint, indexedBytes: stat.size, parserVersion: 3, state: 'ready', lastErrorCode: null, updatedAtMs: 1 },
        entries: [{ ordinal: 0, jsonlLine: 1, byteStart: 0, byteLength: stat.size, entryType: 'user', messageId: 'u1', role: 'user', timestamp: '2026-01-01T00:01:00.000Z', parentToolUseId: null }],
      }),
      async rebuild() { return this.getPublicStatus() },
    }
    let selectedBytes = 0
    const indexedService = new TeamService({
      sessionLocator: { findSessionFile: async () => ({ filePath, projectDir: '-tmp-project' }) },
      localIndexGateway: gateway,
      targetedEntryReader: async (options) => {
        selectedBytes = options.page.entries.reduce((sum, entry) => sum + entry.byteLength, 0)
        return {
          entries: [{
            type: 'user',
            uuid: 'u1',
            message: { role: 'user', content: 'Indexed' },
            timestamp: '2026-01-01T00:01:00.000Z',
          }],
          bytesRead: selectedBytes,
          rangesRead: 1,
        }
      },
    })

    const page = await indexedService.getMemberTranscriptPage('indexed-team', 'agent-lead')

    expect(page.messages.map(message => message.id)).toEqual(['u1'])
    expect(page.afterOrdinal).toBe(0)
    expect(selectedBytes).toBe(stat.size)
  })

  it('rejects an indexed page changed during an empty targeted read and resets from canonical data', async () => {
    await writeTeamConfig(
      'indexed-read-race-team',
      makeTeamConfig({ name: 'indexed-read-race-team' }),
    )
    const transcriptPath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
    const line = (uuid: string, content: string) => `${JSON.stringify({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      timestamp: '2026-01-01T00:01:00.000Z',
    })}\n`
    const originalLines = [
      line('first', 'f'.repeat(70_000)),
      line('middle', 'OLD-MIDDLE'),
      line('last', 'l'.repeat(70_000)),
    ]
    const replacementMiddle = line('middle', 'NEW-MIDDLE')
    expect(Buffer.byteLength(replacementMiddle)).toBe(
      Buffer.byteLength(originalLines[1]!),
    )
    await fs.writeFile(transcriptPath, originalLines.join(''))
    const initialStat = await fs.stat(transcriptPath)
    const fingerprint = await captureSourceFingerprint({
      path: transcriptPath,
      indexedBytes: initialStat.size,
      parserVersion: 3,
    })
    let byteStart = 0
    const messageIds = ['first', 'middle', 'last']
    const locators = originalLines.map((raw, index) => {
      const byteLength = Buffer.byteLength(raw)
      const locator = {
        ordinal: index,
        jsonlLine: index + 1,
        byteStart,
        byteLength,
        entryType: 'user',
        messageId: messageIds[index]!,
        role: 'user',
        timestamp: '2026-01-01T00:01:00.000Z',
        parentToolUseId: null,
      }
      byteStart += byteLength
      return locator
    })
    const locatorPage: SessionEntryLocatorPage = {
      source: {
        path: transcriptPath,
        size: fingerprint.size,
        mtimeMs: fingerprint.mtimeMs,
        fileIdentity: fingerprint.fileIdentity,
        fingerprint: serializeSourceFingerprint(fingerprint),
        indexedBytes: fingerprint.indexedBytes,
        parserVersion: fingerprint.parserVersion,
        state: 'ready',
        lastErrorCode: null,
        updatedAtMs: 1,
      },
      entries: locators,
    }
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => 'on',
      getPublicStatus: () => ({ mode: 'on', state: 'ready', discovered: 1, indexed: 1, degradedSources: 0, databaseBytes: 1, walBytes: 0, lastUpdatedAt: 'now', lastErrorCode: null }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      getSessionEntryLocators: () => locatorPage,
      async rebuild() { return this.getPublicStatus() },
    }
    let rewriteOnRead = false
    let ctimeBeforeRewrite = 0
    let ctimeAfterRewrite = 0
    const indexedService = new TeamService({
      sessionLocator: {
        findSessionFile: async () => ({
          filePath: transcriptPath,
          projectDir: '-tmp-project',
        }),
      },
      localIndexGateway: gateway,
      targetedEntryReader: async (options) => {
        if (rewriteOnRead) {
          rewriteOnRead = false
          ctimeBeforeRewrite = (await fs.stat(transcriptPath)).ctimeMs
          await new Promise(resolve => setTimeout(resolve, 8))
          await fs.writeFile(
            transcriptPath,
            originalLines[0]! + replacementMiddle + originalLines[2]!,
          )
          await fs.utimes(
            transcriptPath,
            fingerprint.mtimeMs / 1000,
            fingerprint.mtimeMs / 1000,
          )
          ctimeAfterRewrite = (await fs.stat(transcriptPath)).ctimeMs
        }
        return readSessionEntriesByLocator(options)
      },
    })
    const initial = await indexedService.getMemberTranscriptPage(
      'indexed-read-race-team',
      'agent-lead',
    )
    const unchanged = await indexedService.getMemberTranscriptPage(
      'indexed-read-race-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )
    expect(unchanged.reset).toBeUndefined()
    expect(unchanged.messages).toEqual([])
    rewriteOnRead = true

    const raced = await indexedService.getMemberTranscriptPage(
      'indexed-read-race-team',
      'agent-lead',
      {
        signature: unchanged.signature,
        cursor: unchanged.cursor,
        afterOrdinal: unchanged.afterOrdinal,
      },
    )

    expect(ctimeAfterRewrite).not.toBe(ctimeBeforeRewrite)
    expect(raced.reset).toBe(true)
    expect(raced.messages.map(message => message.id)).toEqual([
      'first',
      'middle',
      'last',
    ])
    expect(raced.messages[1]?.content).toEqual({
      role: 'user',
      content: 'NEW-MIDDLE',
    })
  })

  it('keeps a stable indexed append incremental after post-read snapshot verification', async () => {
    await writeTeamConfig(
      'indexed-append-team',
      makeTeamConfig({ name: 'indexed-append-team' }),
    )
    const transcriptPath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
    const records = [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }]
    const rawLines = records.map(record => `${JSON.stringify(record)}\n`)
    await fs.writeFile(transcriptPath, rawLines.join(''))
    const makeLocatorPage = async (): Promise<SessionEntryLocatorPage> => {
      const snapshot = await fs.stat(transcriptPath)
      const fingerprint = await captureSourceFingerprint({
        path: transcriptPath,
        indexedBytes: snapshot.size,
        parserVersion: 3,
      })
      let byteStart = 0
      const entries = records.map((record, index) => {
        const byteLength = Buffer.byteLength(rawLines[index]!)
        const locator = {
          ordinal: index,
          jsonlLine: index + 1,
          byteStart,
          byteLength,
          entryType: record.type,
          messageId: record.uuid,
          role: record.message.role,
          timestamp: record.timestamp,
          parentToolUseId: null,
        }
        byteStart += byteLength
        return locator
      })
      return {
        source: {
          path: transcriptPath,
          size: fingerprint.size,
          mtimeMs: fingerprint.mtimeMs,
          fileIdentity: fingerprint.fileIdentity,
          fingerprint: serializeSourceFingerprint(fingerprint),
          indexedBytes: fingerprint.indexedBytes,
          parserVersion: fingerprint.parserVersion,
          state: 'ready',
          lastErrorCode: null,
          updatedAtMs: 1,
        },
        entries,
      }
    }
    let locatorPage = await makeLocatorPage()
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => 'on',
      getPublicStatus: () => ({ mode: 'on', state: 'ready', discovered: 1, indexed: 1, degradedSources: 0, databaseBytes: 1, walBytes: 0, lastUpdatedAt: 'now', lastErrorCode: null }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      getSessionEntryLocators: () => locatorPage,
      async rebuild() { return this.getPublicStatus() },
    }
    const indexedService = new TeamService({
      sessionLocator: {
        findSessionFile: async () => ({
          filePath: transcriptPath,
          projectDir: '-tmp-project',
        }),
      },
      localIndexGateway: gateway,
      targetedEntryReader: readSessionEntriesByLocator,
    })
    const initial = await indexedService.getMemberTranscriptPage(
      'indexed-append-team',
      'agent-lead',
    )
    const appendedRecord = {
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: 'Second' },
      timestamp: '2026-01-01T00:02:00.000Z',
    }
    records.push(appendedRecord as typeof records[number])
    const appendedLine = `${JSON.stringify(appendedRecord)}\n`
    rawLines.push(appendedLine)
    await fs.appendFile(transcriptPath, appendedLine)
    locatorPage = await makeLocatorPage()

    const appended = await indexedService.getMemberTranscriptPage(
      'indexed-append-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(appended.reset).toBeUndefined()
    expect(appended.messages.map(message => message.id)).toEqual(['a1'])
    expect(appended.afterOrdinal).toBe(1)
  })

  it('falls back to the canonical parser for a pending indexed tail', async () => {
    await writeTeamConfig('pending-team', makeTeamConfig({ name: 'pending-team' }))
    const first = `${JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'Complete' },
      timestamp: '2026-01-01T00:01:00.000Z',
    })}\n`
    const finalWithoutNewline = JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: 'Valid pending tail' },
      timestamp: '2026-01-01T00:02:00.000Z',
    })
    const filePath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, first + finalWithoutNewline)
    const stat = await fs.stat(filePath)
    const fingerprint = serializeSourceFingerprint({
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      fileIdentity: null,
      firstWindowHash: 'a'.repeat(64),
      lastWindowHash: 'b'.repeat(64),
      boundaryWindowHash: 'c'.repeat(64),
      indexedBytes: Buffer.byteLength(first),
      parserVersion: 3,
    })
    const gateway: LocalIndexGateway = {
      async start() {},
      async stop() {},
      getMode: () => 'on',
      getPublicStatus: () => ({ mode: 'on', state: 'ready', discovered: 1, indexed: 1, degradedSources: 0, databaseBytes: 1, walBytes: 0, lastUpdatedAt: 'now', lastErrorCode: null }),
      isSessionScopeReady: () => true,
      listSessions: () => ({ sessions: [], total: 0 }),
      findSessionFiles: () => [],
      getSessionEntryLocators: () => ({
        source: {
          path: filePath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          fileIdentity: null,
          fingerprint,
          indexedBytes: Buffer.byteLength(first),
          parserVersion: 3,
          state: 'pending',
          lastErrorCode: null,
          updatedAtMs: 1,
        },
        entries: [{
          ordinal: 0,
          jsonlLine: 1,
          byteStart: 0,
          byteLength: Buffer.byteLength(first),
          entryType: 'user',
          messageId: 'u1',
          role: 'user',
          timestamp: '2026-01-01T00:01:00.000Z',
          parentToolUseId: null,
        }],
      }),
      async rebuild() { return this.getPublicStatus() },
    }
    let targetedReads = 0
    const pendingService = new TeamService({
      sessionLocator: { findSessionFile: async () => ({ filePath, projectDir: '-tmp-project' }) },
      localIndexGateway: gateway,
      targetedEntryReader: async () => {
        targetedReads += 1
        return {
          entries: [JSON.parse(first) as Record<string, unknown>],
          bytesRead: Buffer.byteLength(first),
          rangesRead: 1,
        }
      },
    })

    const messages = await pendingService.getMemberTranscript('pending-team', 'agent-lead')

    expect(messages.map(message => message.id)).toEqual(['u1', 'a1'])
    expect(targetedReads).toBe(0)
  })

  it('resets malformed cursors even when the transcript signature is unchanged', async () => {
    await writeTeamConfig('malformed-cursor-team', makeTeamConfig({ name: 'malformed-cursor-team' }))
    await writeTranscriptFile('-tmp-project', 'session-lead-001', [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }])
    const canonicalService = new TeamService({
      localIndexGateway: disabledIndexGateway(),
    })
    const initial = await canonicalService.getMemberTranscriptPage(
      'malformed-cursor-team',
      'agent-lead',
    )

    const reset = await canonicalService.getMemberTranscriptPage(
      'malformed-cursor-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: 'not-a-valid-cursor',
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(reset.reset).toBe(true)
    expect(reset.messages.map(message => message.id)).toEqual(['u1'])
  })

  it('continues through a partial append and resets after truncation', async () => {
    await writeTeamConfig('cursor-boundary-team', makeTeamConfig({ name: 'cursor-boundary-team' }))
    const transcriptPath = await writeTranscriptFile('-tmp-project', 'session-lead-001', [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }])
    const canonicalService = new TeamService({
      localIndexGateway: disabledIndexGateway(),
    })
    const initial = await canonicalService.getMemberTranscriptPage(
      'cursor-boundary-team',
      'agent-lead',
    )

    await fs.appendFile(transcriptPath, '{"type":"assistant"')
    const partial = await canonicalService.getMemberTranscriptPage(
      'cursor-boundary-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )
    expect(partial.messages).toEqual([])
    expect(partial.reset).toBeUndefined()

    await fs.appendFile(
      transcriptPath,
      ',"uuid":"a1","message":{"role":"assistant","content":"Second"},"timestamp":"2026-01-01T00:02:00.000Z"}\n',
    )
    const completed = await canonicalService.getMemberTranscriptPage(
      'cursor-boundary-team',
      'agent-lead',
      {
        signature: partial.signature,
        cursor: partial.cursor,
        afterOrdinal: partial.afterOrdinal,
      },
    )
    expect(completed.messages.map(message => message.id)).toEqual(['a1'])
    expect(completed.reset).toBeUndefined()

    await fs.writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      uuid: 'replacement',
      message: { role: 'user', content: 'Replacement' },
      timestamp: '2026-01-01T00:03:00.000Z',
    })}\n`)
    const truncated = await canonicalService.getMemberTranscriptPage(
      'cursor-boundary-team',
      'agent-lead',
      {
        signature: completed.signature,
        cursor: completed.cursor,
        afterOrdinal: completed.afterOrdinal,
      },
    )
    expect(truncated.reset).toBe(true)
    expect(truncated.messages.map(message => message.id)).toEqual(['replacement'])
  })

  it('resets a same-size rewrite outside the bounded cursor windows', async () => {
    await writeTeamConfig('large-rewrite-team', makeTeamConfig({ name: 'large-rewrite-team' }))
    const transcriptPath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
    const line = (uuid: string, content: string) => `${JSON.stringify({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      timestamp: '2026-01-01T00:01:00.000Z',
    })}\n`
    const before = line('first', 'f'.repeat(70_000)) +
      line('middle-old', 'OLD-MIDDLE') +
      line('last', 'l'.repeat(70_000))
    const after = line('first', 'f'.repeat(70_000)) +
      line('middle-new', 'NEW-MIDDLE') +
      line('last', 'l'.repeat(70_000))
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before))
    await fs.writeFile(transcriptPath, before)
    const canonicalService = new TeamService({
      localIndexGateway: disabledIndexGateway(),
    })
    const initial = await canonicalService.getMemberTranscriptPage(
      'large-rewrite-team',
      'agent-lead',
    )

    await fs.writeFile(transcriptPath, after)
    const rewritten = await canonicalService.getMemberTranscriptPage(
      'large-rewrite-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: initial.cursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(rewritten.reset).toBe(true)
    expect(rewritten.messages.map(message => message.id)).toEqual([
      'first',
      'middle-new',
      'last',
    ])
  })

  it('safely resets a legacy v1 transcript cursor', async () => {
    await writeTeamConfig('legacy-cursor-team', makeTeamConfig({ name: 'legacy-cursor-team' }))
    await writeTranscriptFile('-tmp-project', 'session-lead-001', [{
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'First' },
      timestamp: '2026-01-01T00:01:00.000Z',
    }])
    const canonicalService = new TeamService({
      localIndexGateway: disabledIndexGateway(),
    })
    const initial = await canonicalService.getMemberTranscriptPage(
      'legacy-cursor-team',
      'agent-lead',
    )
    const legacyPayload = JSON.parse(
      Buffer.from(initial.cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>
    legacyPayload.version = 1
    delete legacyPayload.ctimeMs
    const legacyCursor = Buffer.from(JSON.stringify(legacyPayload)).toString('base64url')

    const reset = await canonicalService.getMemberTranscriptPage(
      'legacy-cursor-team',
      'agent-lead',
      {
        signature: initial.signature,
        cursor: legacyCursor,
        afterOrdinal: initial.afterOrdinal,
      },
    )

    expect(reset.reset).toBe(true)
    expect(reset.messages.map(message => message.id)).toEqual(['u1'])
  })

  it('should return transcript messages for a member', async () => {
    await writeTeamConfig('transcript-team', makeTeamConfig({ name: 'transcript-team' }))

    // Write a mock transcript JSONL for the lead session
    await writeTranscriptFile('-tmp-project', 'session-lead-001', [
      {
        type: 'file-history-snapshot',
        messageId: 'snap-1',
        snapshot: {},
      },
      {
        type: 'user',
        uuid: 'msg-user-1',
        message: { role: 'user', content: 'Hello team' },
        timestamp: '2026-01-01T00:01:00.000Z',
      },
      {
        type: 'assistant',
        uuid: 'msg-asst-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi! Ready to help.' }],
        },
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const messages = await service.getMemberTranscript(
      'transcript-team',
      'agent-lead',
    )
    expect(messages).toHaveLength(2)
    expect(messages[0]!.type).toBe('user')
    expect(messages[0]!.id).toBe('msg-user-1')
    expect(messages[1]!.type).toBe('assistant')
  })

  it('should return empty array when member has no sessionId', async () => {
    const config = makeTeamConfig({ name: 'no-session-team' })
    delete (config.members[0] as Record<string, unknown>).sessionId
    await writeTeamConfig('no-session-team', config)

    const messages = await service.getMemberTranscript(
      'no-session-team',
      'agent-lead',
    )
    expect(messages).toEqual([])
  })

  it('should return empty array when transcript file not found', async () => {
    await writeTeamConfig('no-file-team', makeTeamConfig({ name: 'no-file-team' }))

    // Don't write any transcript file
    const messages = await service.getMemberTranscript(
      'no-file-team',
      'agent-lead',
    )
    expect(messages).toEqual([])
  })

  it('should throw 404 for unknown member', async () => {
    await writeTeamConfig('member-team', makeTeamConfig({ name: 'member-team' }))

    expect(
      service.getMemberTranscript('member-team', 'nonexistent-agent'),
    ).rejects.toThrow('Team member not found')
  })

  it('should skip meta entries in transcript', async () => {
    await writeTeamConfig('meta-team', makeTeamConfig({ name: 'meta-team' }))

    await writeTranscriptFile('-tmp-project', 'session-lead-001', [
      {
        type: 'user',
        uuid: 'msg-meta',
        message: { role: 'user', content: 'internal meta' },
        isMeta: true,
        timestamp: '2026-01-01T00:00:30.000Z',
      },
      {
        type: 'user',
        uuid: 'msg-real',
        message: { role: 'user', content: 'Real message' },
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ])

    const messages = await service.getMemberTranscript('meta-team', 'agent-lead')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.id).toBe('msg-real')
  })

  // --------------------------------------------------------------------------
  // sendMemberMessage
  // --------------------------------------------------------------------------

  it('should write member messages into the teammate inbox', async () => {
    await writeTeamConfig('mailbox-team', makeTeamConfig({ name: 'mailbox-team' }))

    await service.sendMemberMessage(
      'mailbox-team',
      'agent-worker',
      'Please review the latest diff',
    )

    const inboxPath = path.join(
      tmpDir,
      'teams',
      'mailbox-team',
      'inboxes',
      'Worker-Agent.json',
    )
    const rawInbox = await fs.readFile(inboxPath, 'utf-8')
    const inbox = JSON.parse(rawInbox) as Array<{
      from: string
      text: string
      read: boolean
    }>

    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      from: 'user',
      text: 'Please review the latest diff',
      read: false,
    })
  })

  it('should send messages to inbox-discovered members', async () => {
    await writeTeamConfig('inbox-team', makeTeamConfig({ name: 'inbox-team' }))
    const inboxDir = path.join(tmpDir, 'teams', 'inbox-team', 'inboxes')
    await fs.mkdir(inboxDir, { recursive: true })
    await fs.writeFile(path.join(inboxDir, 'security-reviewer.json'), '[]', 'utf-8')

    await service.sendMemberMessage(
      'inbox-team',
      'security-reviewer@inbox-team',
      'Check the auth changes',
    )

    const rawInbox = await fs.readFile(
      path.join(inboxDir, 'security-reviewer.json'),
      'utf-8',
    )
    const inbox = JSON.parse(rawInbox) as Array<{ text: string }>
    expect(inbox.at(-1)?.text).toBe('Check the auth changes')
  })

  // --------------------------------------------------------------------------
  // deleteTeam
  // --------------------------------------------------------------------------

  it('should delete a team with no active members', async () => {
    const config = makeTeamConfig({ name: 'deletable' })
    // Set all members to inactive
    for (const member of config.members) {
      ;(member as Record<string, unknown>).isActive = false
    }
    await writeTeamConfig('deletable', config)

    await service.deleteTeam('deletable')

    // Team dir should be gone
    const teamDir = path.join(tmpDir, 'teams', 'deletable')
    expect(fs.access(teamDir)).rejects.toThrow()
  })

  it('should refuse to delete a team with active members', async () => {
    await writeTeamConfig('active-team', makeTeamConfig({ name: 'active-team' }))

    expect(service.deleteTeam('active-team')).rejects.toThrow(
      'has active members',
    )
  })

  it('should throw 404 when deleting non-existent team', async () => {
    expect(service.deleteTeam('ghost')).rejects.toThrow('Team not found')
  })
})

// ============================================================================
// Teams API integration tests
// ============================================================================

describe('Teams API', () => {
  let baseUrl: string
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new TeamService()

    const { handleTeamsApi } = await import('../api/teams.js')

    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',

      async fetch(req) {
        const url = new URL(req.url)
        const segments = url.pathname.split('/').filter(Boolean)

        if (segments[0] === 'api' && segments[1] === 'teams') {
          return handleTeamsApi(req, url, segments)
        }

        return new Response('Not Found', { status: 404 })
      },
    })
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    if (server) {
      server.stop(true)
      server = null
    }
    await cleanupTmpDir()
  })

  it('GET /api/teams should return empty list', async () => {
    const res = await fetch(`${baseUrl}/api/teams`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { teams: unknown[] }
    expect(body.teams).toEqual([])
  })

  it('GET /api/teams should list teams', async () => {
    await writeTeamConfig('api-team', makeTeamConfig({ name: 'api-team' }))

    const res = await fetch(`${baseUrl}/api/teams`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { teams: Array<{ name: string }> }
    expect(body.teams).toHaveLength(1)
    expect(body.teams[0]!.name).toBe('api-team')
  })

  it('GET /api/teams/:name should return team detail', async () => {
    await writeTeamConfig(
      'detail',
      makeTeamConfig({ name: 'detail', leadSessionId: 'leader-session-id' }),
    )

    const res = await fetch(`${baseUrl}/api/teams/detail`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      name: string
      leadAgentId: string
      leadSessionId?: string
      members: Array<{ agentId: string }>
    }
    expect(body.name).toBe('detail')
    expect(body.leadAgentId).toBe('agent-lead')
    expect(body.leadSessionId).toBe('leader-session-id')
    expect(body.members).toHaveLength(2)
  })

  it('GET /api/teams/:name should 404 for unknown team', async () => {
    const res = await fetch(`${baseUrl}/api/teams/nonexistent`)
    expect(res.status).toBe(404)
  })

  it('GET /api/teams/:name/members/:id/transcript should return messages', async () => {
    await writeTeamConfig('t-team', makeTeamConfig({ name: 't-team' }))

    await writeTranscriptFile('-tmp-project', 'session-lead-001', [
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'Hello' },
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ])

    const res = await fetch(
      `${baseUrl}/api/teams/t-team/members/agent-lead/transcript`,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      messages: Array<{ id: string; type: string }>
    }
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]!.type).toBe('user')
  })

  it('supports an additive transcript cursor without changing the legacy full response', async () => {
    await writeTeamConfig('delta-team', makeTeamConfig({ name: 'delta-team' }))
    await writeTranscriptFile('-tmp-project', 'session-lead-001', [
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'First' },
        timestamp: '2026-01-01T00:01:00.000Z',
      },
      {
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: 'Second' },
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const initial = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript?incremental=true`,
    )
    const initialBody = (await initial.json()) as {
      messages: Array<{ id: string }>
      signature?: string
      cursor?: string
      afterOrdinal?: number
    }
    expect(initialBody.messages.map(message => message.id)).toEqual(['u1', 'a1'])
    expect(initialBody.signature).toBeString()
    expect(initialBody.cursor).toBeString()
    expect(initialBody.afterOrdinal).toBeNumber()

    const unchanged = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript?incremental=true&signature=${encodeURIComponent(initialBody.signature!)}&afterOrdinal=${initialBody.afterOrdinal}`,
    )
    const unchangedBody = (await unchanged.json()) as {
      messages: unknown[]
      signature: string
      afterOrdinal: number
    }
    expect(unchangedBody).toMatchObject({
      messages: [],
      signature: initialBody.signature,
      afterOrdinal: initialBody.afterOrdinal,
    })
    expect((unchangedBody as { cursor?: string }).cursor).toBeString()

    await fs.appendFile(
      path.join(tmpDir, 'projects', '-tmp-project', 'session-lead-001.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: 'Third' },
        timestamp: '2026-01-01T00:03:00.000Z',
      })}\n`,
    )
    const appended = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript?incremental=true&signature=${encodeURIComponent(initialBody.signature!)}&cursor=${encodeURIComponent(initialBody.cursor!)}&afterOrdinal=${initialBody.afterOrdinal}`,
    )
    const appendedBody = (await appended.json()) as {
      messages: Array<{ id: string }>
      signature: string
      cursor: string
      afterOrdinal: number
      reset?: boolean
    }
    expect(appendedBody.messages.map(message => message.id)).toEqual(['u2'])
    expect(appendedBody.afterOrdinal).toBe(2)
    expect(appendedBody.reset).toBeUndefined()

    const transcriptPath = path.join(
      tmpDir,
      'projects',
      '-tmp-project',
      'session-lead-001.jsonl',
    )
    const beforeRewrite = await fs.stat(transcriptPath)
    const rewritten = [
      { type: 'user', uuid: 'x1', message: { role: 'user', content: 'Furst' }, timestamp: '2026-01-01T00:01:00.000Z' },
      { type: 'assistant', uuid: 'b1', message: { role: 'assistant', content: 'Secand' }, timestamp: '2026-01-01T00:02:00.000Z' },
      { type: 'user', uuid: 'x2', message: { role: 'user', content: 'Thurd' }, timestamp: '2026-01-01T00:03:00.000Z' },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n'
    await fs.writeFile(transcriptPath, rewritten)
    expect((await fs.stat(transcriptPath)).size).toBe(beforeRewrite.size)
    await fs.utimes(transcriptPath, beforeRewrite.atime, beforeRewrite.mtime)

    const rewrittenResponse = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript?incremental=true&signature=${encodeURIComponent(appendedBody.signature)}&cursor=${encodeURIComponent(appendedBody.cursor)}&afterOrdinal=${appendedBody.afterOrdinal}`,
    )
    const rewrittenBody = (await rewrittenResponse.json()) as {
      messages: Array<{ id: string }>
      reset?: boolean
    }
    expect(rewrittenBody.reset).toBe(true)
    expect(rewrittenBody.messages.map(message => message.id)).toEqual(['x1', 'b1', 'x2'])

    const legacy = await fetch(
      `${baseUrl}/api/teams/delta-team/members/agent-lead/transcript`,
    )
    const legacyBody = (await legacy.json()) as { messages: Array<{ id: string }> }
    expect(Object.keys(legacyBody)).toEqual(['messages'])
    expect(legacyBody.messages.map(message => message.id)).toEqual(['x1', 'b1', 'x2'])
  })

  it('GET /api/teams/:name/members/:id/transcript should 404 for unknown member', async () => {
    await writeTeamConfig('t2-team', makeTeamConfig({ name: 't2-team' }))

    const res = await fetch(
      `${baseUrl}/api/teams/t2-team/members/unknown-agent/transcript`,
    )
    expect(res.status).toBe(404)
  })

  it('POST /api/teams/:name/members/:id/messages should enqueue a mailbox message', async () => {
    await writeTeamConfig('send-team', makeTeamConfig({ name: 'send-team' }))

    const res = await fetch(
      `${baseUrl}/api/teams/send-team/members/agent-worker/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Please continue with the failing test' }),
      },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    const rawInbox = await fs.readFile(
      path.join(tmpDir, 'teams', 'send-team', 'inboxes', 'Worker-Agent.json'),
      'utf-8',
    )
    const inbox = JSON.parse(rawInbox) as Array<{ text: string }>
    expect(inbox.at(-1)?.text).toBe('Please continue with the failing test')
  })

  it('DELETE /api/teams/:name should delete team', async () => {
    const config = makeTeamConfig({ name: 'del-team' })
    for (const member of (config as { members: Array<Record<string, unknown>> }).members) {
      member.isActive = false
    }
    await writeTeamConfig('del-team', config)

    const res = await fetch(`${baseUrl}/api/teams/del-team`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)

    // Verify it's gone
    const res2 = await fetch(`${baseUrl}/api/teams/del-team`)
    expect(res2.status).toBe(404)
  })

  it('DELETE /api/teams/:name should 409 when team has active members', async () => {
    await writeTeamConfig('active', makeTeamConfig({ name: 'active' }))

    const res = await fetch(`${baseUrl}/api/teams/active`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(409)
  })

  it('POST /api/teams should return 405', async () => {
    const res = await fetch(`${baseUrl}/api/teams`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
