/**
 * TeamService — 读取 CLI 生成的 Agent Teams 配置
 *
 * Team 配置存储在 ~/.claude/teams/{name}/config.json
 * 成员 transcript 存储为 JSONL 文件:
 *   - 有 sessionId 的成员: ~/.claude/projects/{project}/{sessionId}.jsonl
 *   - in-process 成员 (无 sessionId): ~/.claude/projects/{project}/{leadSessionId}/subagents/agent-*.jsonl
 * 成员发现: config.json + inboxes/ 目录 (解决并发写入丢失成员的问题)
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'node:crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { sessionService } from './sessionService.js'
import { localIndexCoordinator } from './localIndex/coordinator.js'
import { readSessionEntriesByLocator } from './localIndex/sessionEntries.js'
import { deserializeSourceFingerprint } from './localIndex/sourceFingerprint.js'
import type { LocalIndexGateway } from './localIndex/sessionIndex.js'

// ─── Types ─────────────────────────────────────────────────────────────────

export type TeamMember = {
  agentId: string
  name: string
  agentType?: string
  model?: string
  color?: string
  backendType?: string
  status: 'running' | 'completed' | 'idle' | 'failed'
  joinedAt: number
  cwd: string
  sessionId?: string
}

export type TeamSummary = {
  name: string
  description?: string
  createdAt: number
  memberCount: number
  activeMemberCount: number
}

export type TeamDetail = TeamSummary & {
  leadAgentId: string
  leadSessionId?: string
  members: TeamMember[]
}

export type TranscriptMessage = {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  timestamp: string
  model?: string
  parentToolUseId?: string
}

export type TeamTranscriptPage = {
  messages: TranscriptMessage[]
  signature: string
  cursor: string
  afterOrdinal: number
  reset?: boolean
}

export type TeamTranscriptPageOptions = {
  signature?: string
  cursor?: string
  afterOrdinal?: number
}

type TranscriptCursor = {
  version: 2
  size: number
  ctimeMs: number
  fileIdentity: string | null
  firstWindowHash: string
  lastWindowHash: string
  afterOrdinal: number
}

const CURSOR_WINDOW_BYTES = 64 * 1024
const MESSAGE_ENTRY_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'tool_use',
  'tool_result',
])

function hash(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeTranscriptCursor(value: string | undefined): TranscriptCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TranscriptCursor
    if (
      parsed.version === 2 &&
      Number.isSafeInteger(parsed.size) && parsed.size >= 0 &&
      Number.isFinite(parsed.ctimeMs) && parsed.ctimeMs >= 0 &&
      Number.isSafeInteger(parsed.afterOrdinal) && parsed.afterOrdinal >= -1 &&
      (parsed.fileIdentity === null || typeof parsed.fileIdentity === 'string') &&
      typeof parsed.firstWindowHash === 'string' &&
      typeof parsed.lastWindowHash === 'string'
    ) return parsed
  } catch {
    // Treat malformed client cursors as a reset request.
  }
  return null
}

function cursorForBuffer(
  bytes: Buffer,
  fileIdentity: string | null,
  ctimeMs: number,
  afterOrdinal: number,
): TranscriptCursor {
  return {
    version: 2,
    size: bytes.length,
    ctimeMs,
    fileIdentity,
    firstWindowHash: hash(bytes.subarray(0, Math.min(bytes.length, CURSOR_WINDOW_BYTES))),
    lastWindowHash: hash(bytes.subarray(Math.max(0, bytes.length - CURSOR_WINDOW_BYTES))),
    afterOrdinal,
  }
}

function bufferPreservesCursorPrefix(
  bytes: Buffer,
  cursor: TranscriptCursor,
  fileIdentity: string | null,
): boolean {
  if (bytes.length <= cursor.size) return false
  if (
    cursor.fileIdentity !== null &&
    fileIdentity !== null &&
    cursor.fileIdentity !== fileIdentity
  ) return false
  const firstEnd = Math.min(cursor.size, CURSOR_WINDOW_BYTES)
  const lastStart = Math.max(0, cursor.size - CURSOR_WINDOW_BYTES)
  return hash(bytes.subarray(0, firstEnd)) === cursor.firstWindowHash &&
    hash(bytes.subarray(lastStart, cursor.size)) === cursor.lastWindowHash
}

function sameTranscriptFileSnapshot(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
}

/** Raw config.json structure written by CLI */
type TeamFileRaw = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  members: Array<{
    agentId: string
    name: string
    agentType?: string
    model?: string
    prompt?: string
    color?: string
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    sessionId?: string
    backendType?: string
    isActive?: boolean
    mode?: string
  }>
}

// ─── Service ───────────────────────────────────────────────────────────────

export class TeamService {
  private readonly sessionLocator: Pick<typeof sessionService, 'findSessionFile'>
  private readonly localIndexGateway: LocalIndexGateway
  private readonly targetedEntryReader: typeof readSessionEntriesByLocator

  constructor(options: {
    sessionLocator?: Pick<typeof sessionService, 'findSessionFile'>
    localIndexGateway?: LocalIndexGateway
    targetedEntryReader?: typeof readSessionEntriesByLocator
  } = {}) {
    this.sessionLocator = options.sessionLocator ?? sessionService
    this.localIndexGateway = options.localIndexGateway ?? localIndexCoordinator
    this.targetedEntryReader = options.targetedEntryReader ?? readSessionEntriesByLocator
  }

  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getTeamsDir(): string {
    return path.join(this.getConfigDir(), 'teams')
  }

  private getProjectsDir(): string {
    return path.join(this.getConfigDir(), 'projects')
  }

  // ── List all teams ──────────────────────────────────────────────────────

  async listTeams(): Promise<TeamSummary[]> {
    const teamsDir = this.getTeamsDir()

    try {
      await fs.access(teamsDir)
    } catch {
      return []
    }

    const entries = await fs.readdir(teamsDir, { withFileTypes: true })
    const teams: TeamSummary[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      try {
        const config = await this.loadTeamConfig(entry.name)
        // Include inbox-discovered members in the count
        const inboxNames = await this.discoverInboxMembers(entry.name)
        const configNames = new Set(config.members.map((m) => m.name))
        const extraCount = inboxNames.filter((n) => !configNames.has(n)).length
        const summary = this.toSummary(config)
        summary.memberCount += extraCount
        summary.activeMemberCount += extraCount // assume running if newly discovered
        teams.push(summary)
      } catch {
        // Skip malformed team directories
      }
    }

    return teams
  }

  // ── Get team detail ─────────────────────────────────────────────────────

  async getTeam(name: string): Promise<TeamDetail> {
    const config = await this.loadTeamConfig(name)

    const members: TeamMember[] = config.members.map((m) => ({
      agentId: m.agentId,
      name: m.name,
      agentType: m.agentType,
      model: m.model,
      color: m.color,
      backendType: m.backendType,
      status: this.deriveStatus(m.isActive),
      joinedAt: m.joinedAt,
      cwd: m.cwd,
      sessionId: m.sessionId,
    }))

    // Discover members from inboxes/ that aren't in config.json (race condition fix)
    const inboxNames = await this.discoverInboxMembers(name)
    const configNames = new Set(config.members.map((m) => m.name))

    for (const inboxName of inboxNames) {
      if (!configNames.has(inboxName)) {
        members.push({
          agentId: `${inboxName}@${name}`,
          name: inboxName,
          agentType: 'general-purpose',
          status: 'running', // assume running since we can see their inbox
          joinedAt: config.createdAt,
          cwd: config.members[0]?.cwd || '',
        })
      }
    }

    if (config.leadSessionId) {
      const subagentNames = await this.discoverSubagentMembers(
        config.leadSessionId,
      )
      for (const subagentName of subagentNames) {
        if (
          !configNames.has(subagentName) &&
          !members.some((member) => member.name === subagentName)
        ) {
          members.push({
            agentId: `${subagentName}@${name}`,
            name: subagentName,
            status: 'running',
            joinedAt: config.createdAt,
            cwd: config.members[0]?.cwd || '',
          })
        }
      }
    }

    return {
      ...this.toSummary(config),
      leadAgentId: config.leadAgentId,
      leadSessionId: config.leadSessionId,
      memberCount: members.length,
      activeMemberCount: members.filter(
        (m) => m.status === 'running',
      ).length,
      members,
    }
  }

  // ── Get member transcript ───────────────────────────────────────────────

  async getMemberTranscript(
    teamName: string,
    agentId: string,
  ): Promise<TranscriptMessage[]> {
    return (await this.getMemberTranscriptPage(teamName, agentId)).messages
  }

  async getMemberTranscriptPage(
    teamName: string,
    agentId: string,
    options: TeamTranscriptPageOptions = {},
  ): Promise<TeamTranscriptPage> {
    const config = await this.loadTeamConfig(teamName)
    const memberName = await this.resolveMemberName(config, teamName, agentId)
    if (!memberName) {
      throw ApiError.notFound(
        `Team member not found: ${agentId} in team ${teamName}`,
      )
    }

    let transcriptPath: string | null = null

    // Try config.json member with sessionId first. SessionService uses the
    // scalar session index for this lookup when it is ready.
    const member = config.members.find((m) => m.agentId === agentId)
    if (member?.sessionId) {
      transcriptPath = (await this.sessionLocator.findSessionFile(member.sessionId))?.filePath ??
        await this.findTranscriptFile(member.sessionId)
    }

    // Fallback: search subagents directory for this member's transcript
    if (!transcriptPath && config.leadSessionId) {
      const subagentPath = await this.findSubagentTranscript(
        config.leadSessionId,
        memberName,
      )
      if (subagentPath) {
        transcriptPath = subagentPath
      }
    }

    if (!transcriptPath) {
      return {
        messages: [],
        signature: 'missing',
        cursor: encodeTranscriptCursor(cursorForBuffer(Buffer.alloc(0), null, 0, -1)),
        afterOrdinal: -1,
      }
    }

    const indexed = await this.readIndexedTranscriptPage(transcriptPath, options)
    if (indexed) return indexed
    return this.parseTranscriptFilePage(transcriptPath, options)
  }

  async sendMemberMessage(
    teamName: string,
    agentId: string,
    content: string,
  ): Promise<void> {
    const text = content.trim()
    if (!text) {
      throw ApiError.badRequest('content (string) is required in request body')
    }

    const config = await this.loadTeamConfig(teamName)
    const recipientName = await this.resolveMemberName(
      config,
      teamName,
      agentId,
    )

    if (!recipientName) {
      throw ApiError.notFound(
        `Team member not found: ${agentId} in team ${teamName}`,
      )
    }

    await writeToMailbox(
      recipientName,
      {
        from: 'user',
        text,
        timestamp: new Date().toISOString(),
      },
      teamName,
    )
  }

  // ── Delete team ─────────────────────────────────────────────────────────

  async deleteTeam(name: string): Promise<void> {
    const config = await this.loadTeamConfig(name)

    const hasActive = config.members.some(
      (m) => m.isActive === undefined || m.isActive === true,
    )
    if (hasActive) {
      throw ApiError.conflict(
        `Cannot delete team "${name}": has active members`,
      )
    }

    const teamDir = path.join(this.getTeamsDir(), name)
    await fs.rm(teamDir, { recursive: true, force: true })
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  private async loadTeamConfig(name: string): Promise<TeamFileRaw> {
    const configPath = path.join(this.getTeamsDir(), name, 'config.json')

    try {
      const raw = await fs.readFile(configPath, 'utf-8')
      return JSON.parse(raw) as TeamFileRaw
    } catch {
      throw ApiError.notFound(`Team not found: ${name}`)
    }
  }

  /**
   * Discover member names from the inboxes/ directory.
   * Each file `{name}.json` in inboxes/ represents a team member.
   * Excludes the team-lead inbox since the leader is already in config.
   */
  private async discoverInboxMembers(teamName: string): Promise<string[]> {
    const inboxDir = path.join(this.getTeamsDir(), teamName, 'inboxes')

    try {
      const files = await fs.readdir(inboxDir)
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .filter((name) => name !== 'team-lead')
    } catch {
      return []
    }
  }

  private toSummary(config: TeamFileRaw): TeamSummary {
    const activeMemberCount = config.members.filter(
      (m) => m.isActive === undefined || m.isActive === true,
    ).length

    return {
      name: config.name,
      description: config.description,
      createdAt: config.createdAt,
      memberCount: config.members.length,
      activeMemberCount,
    }
  }

  private deriveStatus(
    isActive: boolean | undefined,
  ): 'running' | 'completed' | 'idle' | 'failed' {
    if (isActive === false) return 'idle'
    // isActive === undefined || isActive === true
    return 'running'
  }

  private async resolveMemberName(
    config: TeamFileRaw,
    teamName: string,
    agentId: string,
  ): Promise<string | null> {
    const configMember = config.members.find((m) => m.agentId === agentId)
    if (configMember?.name) {
      return configMember.name
    }

    const parsedName = agentId.includes('@') ? agentId.split('@')[0]! : agentId
    const inboxNames = await this.discoverInboxMembers(teamName)
    if (inboxNames.includes(parsedName)) {
      return parsedName
    }

    if (config.leadSessionId) {
      const subagentNames = await this.discoverSubagentMembers(
        config.leadSessionId,
      )
      if (subagentNames.includes(parsedName)) {
        return parsedName
      }
    }

    return null
  }

  private async discoverSubagentMembers(leadSessionId: string): Promise<string[]> {
    const projectsDir = this.getProjectsDir()

    try {
      await fs.access(projectsDir)
    } catch {
      return []
    }

    const discovered = new Set<string>()
    const projectEntries = await fs.readdir(projectsDir, {
      withFileTypes: true,
    })

    for (const projEntry of projectEntries) {
      if (!projEntry.isDirectory()) continue

      const subagentsDir = path.join(
        projectsDir,
        projEntry.name,
        leadSessionId,
        'subagents',
      )

      let files: string[]
      try {
        files = await fs.readdir(subagentsDir)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const discoveredName = await this.extractSubagentName(
          path.join(subagentsDir, file),
        )
        if (discoveredName && discoveredName !== 'team-lead') {
          discovered.add(discoveredName)
        }
      }
    }

    return [...discovered]
  }

  /** Search ~/.claude/projects/ for a JSONL file matching the sessionId. */
  private async findTranscriptFile(
    sessionId: string,
  ): Promise<string | null> {
    const projectsDir = this.getProjectsDir()

    try {
      await fs.access(projectsDir)
    } catch {
      return null
    }

    const projectEntries = await fs.readdir(projectsDir, {
      withFileTypes: true,
    })

    for (const entry of projectEntries) {
      if (!entry.isDirectory()) continue

      const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`)
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        // Not in this project directory
      }
    }

    return null
  }

  /**
   * Search subagents directory for a specific member's transcript.
   * Path: ~/.claude/projects/{project}/{leadSessionId}/subagents/agent-*.jsonl
   *
   * Matches by reading the first user message and checking for the member name
   * in the `<teammate-message>` content (e.g., "你是 **security-reviewer**").
   */
  private async findSubagentTranscript(
    leadSessionId: string,
    memberName: string,
  ): Promise<string | null> {
    const projectsDir = this.getProjectsDir()

    try {
      await fs.access(projectsDir)
    } catch {
      return null
    }

    const projectEntries = await fs.readdir(projectsDir, {
      withFileTypes: true,
    })

    for (const projEntry of projectEntries) {
      if (!projEntry.isDirectory()) continue

      const subagentsDir = path.join(
        projectsDir,
        projEntry.name,
        leadSessionId,
        'subagents',
      )

      let files: string[]
      try {
        files = await fs.readdir(subagentsDir)
      } catch {
        continue
      }

      // Check each subagent file — find the one matching this member
      // Use the most recent file if multiple match (handles retries)
      let bestMatch: { path: string; mtime: number } | null = null

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue

        const filePath = path.join(subagentsDir, file)

        try {
          const head = await this.readTranscriptHead(filePath)
          if (
            head.includes(`"${memberName}"`) ||
            head.includes(`**${memberName}**`) ||
            head.includes(`name":"${memberName}`) ||
            (await this.extractSubagentName(filePath)) === memberName
          ) {
            const stat = await fs.stat(filePath)
            if (!bestMatch || stat.mtimeMs > bestMatch.mtime) {
              bestMatch = { path: filePath, mtime: stat.mtimeMs }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      if (bestMatch) {
        return bestMatch.path
      }
    }

    return null
  }

  private async readTranscriptHead(filePath: string): Promise<string> {
    const fd = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const { bytesRead } = await fd.read(buf, 0, 8192, 0)
      return buf.toString('utf-8', 0, bytesRead)
    } finally {
      await fd.close()
    }
  }

  private async extractSubagentName(filePath: string): Promise<string | null> {
    try {
      const head = await this.readTranscriptHead(filePath)
      const lines = head.split('\n').filter((line) => line.trim().length > 0)

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          if (typeof entry.agentName === 'string' && entry.agentName.trim()) {
            return entry.agentName
          }
          if (typeof entry.agentId === 'string' && entry.agentId.includes('@')) {
            return entry.agentId.split('@')[0] ?? null
          }
        } catch {
          // Ignore partial or non-JSON lines in the preview window.
        }
      }

      const nameMatch =
        head.match(/"agentName"\s*:\s*"([^"]+)"/) ||
        head.match(/"name"\s*:\s*"([^"]+)"/) ||
        head.match(/\*\*([a-zA-Z0-9_-]+)\*\*/)

      return nameMatch?.[1] ?? null
    } catch {
      return null
    }
  }

  private fileIdentity(stat: { dev: number; ino: number }): string | null {
    return process.platform === 'win32' || stat.ino === 0
      ? null
      : `${stat.dev}:${stat.ino}`
  }

  private transcriptMessageFromEntry(
    entry: Record<string, unknown>,
  ): TranscriptMessage | null {
    const entryType = entry.type as string | undefined
    if (!entryType || !MESSAGE_ENTRY_TYPES.has(entryType) || entry.isMeta) return null
    return {
      id: (entry.uuid as string) || crypto.randomUUID(),
      type: entryType as TranscriptMessage['type'],
      content: entry.message ?? entry.content ?? null,
      timestamp: (entry.timestamp as string) || new Date().toISOString(),
      ...(typeof entry.parentToolUseId === 'string'
        ? { parentToolUseId: entry.parentToolUseId }
        : {}),
      ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
    }
  }

  private async filePreservesCursorPrefix(
    filePath: string,
    cursor: TranscriptCursor,
  ): Promise<boolean> {
    let handle: fs.FileHandle | undefined
    try {
      const stat = await fs.stat(filePath)
      const identity = this.fileIdentity(stat)
      if (stat.size <= cursor.size) return false
      if (
        cursor.fileIdentity !== null &&
        identity !== null &&
        cursor.fileIdentity !== identity
      ) return false

      handle = await fs.open(filePath, 'r')
      const firstLength = Math.min(cursor.size, CURSOR_WINDOW_BYTES)
      const lastStart = Math.max(0, cursor.size - CURSOR_WINDOW_BYTES)
      const lastLength = cursor.size - lastStart
      const first = Buffer.alloc(firstLength)
      const last = Buffer.alloc(lastLength)
      if (firstLength > 0) await handle.read(first, 0, firstLength, 0)
      if (lastLength > 0) await handle.read(last, 0, lastLength, lastStart)
      return hash(first) === cursor.firstWindowHash &&
        hash(last) === cursor.lastWindowHash
    } catch {
      return false
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  private async readIndexedTranscriptPage(
    filePath: string,
    options: TeamTranscriptPageOptions,
  ): Promise<TeamTranscriptPage | null> {
    try {
      if (
        this.localIndexGateway.getMode() !== 'on' ||
        !this.localIndexGateway.isSessionScopeReady() ||
        !this.localIndexGateway.getSessionEntryLocators
      ) return null
      const page = this.localIndexGateway.getSessionEntryLocators(filePath)
      if (!page) return null
      // A pending source can contain a valid final JSON object without a
      // newline. Locators intentionally exclude that tail, while the legacy
      // canonical parser includes it, so never serve a partial indexed page.
      if (
        page.source.state !== 'ready' ||
        page.source.indexedBytes !== page.source.size
      ) return null
      const fingerprint = deserializeSourceFingerprint(page.source.fingerprint)
      if (!fingerprint) return null
      const currentStat = await fs.stat(filePath)
      const currentIdentity = this.fileIdentity(currentStat)

      const currentAfterOrdinal = page.entries.at(-1)?.ordinal ?? -1
      const signature = hash(page.source.fingerprint)
      const previousCursor = decodeTranscriptCursor(options.cursor)
      let afterOrdinal = options.afterOrdinal ?? -1
      let reset = false
      if (options.cursor !== undefined && !previousCursor) {
        afterOrdinal = -1
        reset = true
      } else if (afterOrdinal >= 0 && (!options.signature || !previousCursor)) {
        afterOrdinal = -1
        reset = true
      } else if (afterOrdinal > currentAfterOrdinal) {
        afterOrdinal = -1
        reset = true
      } else if (previousCursor && previousCursor.afterOrdinal !== afterOrdinal) {
        afterOrdinal = -1
        reset = true
      } else if (options.signature) {
        if (options.signature === signature) {
          const snapshotMatches = previousCursor &&
            previousCursor.size === currentStat.size &&
            previousCursor.ctimeMs === currentStat.ctimeMs &&
            (
              previousCursor.fileIdentity === null ||
              currentIdentity === null ||
              previousCursor.fileIdentity === currentIdentity
            )
          if (!snapshotMatches) {
            afterOrdinal = -1
            reset = true
          }
        } else {
          const appendProven = previousCursor &&
            currentStat.size > previousCursor.size &&
            await this.filePreservesCursorPrefix(filePath, previousCursor)
          if (!appendProven) {
            afterOrdinal = -1
            reset = true
          }
        }
      }

      if (currentStat.size !== fingerprint.size) {
        return null
      }

      const selected = page.entries.filter(locator =>
        locator.ordinal > afterOrdinal && MESSAGE_ENTRY_TYPES.has(locator.entryType),
      )
      const result = await this.targetedEntryReader({
        transcriptPath: filePath,
        projectsRoot: this.getProjectsDir(),
        expectedProjectDir: path.basename(path.dirname(filePath)),
        page: { source: page.source, entries: selected },
      })
      if (!result) return null
      const statAfterRead = await fs.stat(filePath)
      if (!sameTranscriptFileSnapshot(currentStat, statAfterRead)) return null

      const messages = result.entries
        .map(entry => this.transcriptMessageFromEntry(entry))
        .filter((message): message is TranscriptMessage => message !== null)
      const cursor = encodeTranscriptCursor({
        version: 2,
        size: fingerprint.size,
        ctimeMs: currentStat.ctimeMs,
        fileIdentity: currentIdentity,
        firstWindowHash: fingerprint.firstWindowHash,
        lastWindowHash: fingerprint.lastWindowHash,
        afterOrdinal: currentAfterOrdinal,
      })
      return {
        messages,
        signature,
        cursor,
        afterOrdinal: currentAfterOrdinal,
        ...(reset ? { reset: true } : {}),
      }
    } catch {
      return null
    }
  }

  /** Canonical parser used for legacy reads and every degraded/stale fallback. */
  private async parseTranscriptFilePage(
    filePath: string,
    options: TeamTranscriptPageOptions,
  ): Promise<TeamTranscriptPage> {
    const bytes = await fs.readFile(filePath)
    const stat = await fs.stat(filePath)
    const identity = this.fileIdentity(stat)
    const entries: Array<{ ordinal: number; message: TranscriptMessage }> = []
    let ordinal = -1
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        ordinal += 1
        const message = this.transcriptMessageFromEntry(entry)
        if (message) entries.push({ ordinal, message })
      } catch {
        // Skip unparseable lines
      }
    }
    const currentAfterOrdinal = ordinal
    const signature = hash(bytes)
    const previousCursor = decodeTranscriptCursor(options.cursor)
    let afterOrdinal = options.afterOrdinal ?? -1
    let reset = false
    if (options.cursor !== undefined && !previousCursor) {
      afterOrdinal = -1
      reset = true
    } else if (afterOrdinal >= 0 && !options.signature) {
      afterOrdinal = -1
      reset = true
    } else if (afterOrdinal > currentAfterOrdinal) {
      afterOrdinal = -1
      reset = true
    } else if (previousCursor && previousCursor.afterOrdinal !== afterOrdinal) {
      afterOrdinal = -1
      reset = true
    } else if (options.signature) {
      if (options.signature === signature) {
        const snapshotMismatch = previousCursor &&
          (
            previousCursor.size !== bytes.length ||
            previousCursor.ctimeMs !== stat.ctimeMs ||
            (
              previousCursor.fileIdentity !== null &&
              identity !== null &&
              previousCursor.fileIdentity !== identity
            )
          )
        if (snapshotMismatch) {
          afterOrdinal = -1
          reset = true
        }
      } else {
        const appendProven = previousCursor &&
          bytes.length > previousCursor.size &&
          bufferPreservesCursorPrefix(bytes, previousCursor, identity)
        if (!appendProven) {
          afterOrdinal = -1
          reset = true
        }
      }
    }
    const cursor = encodeTranscriptCursor(cursorForBuffer(
      bytes,
      identity,
      stat.ctimeMs,
      currentAfterOrdinal,
    ))
    return {
      messages: entries
        .filter(entry => entry.ordinal > afterOrdinal)
        .map(entry => entry.message),
      signature,
      cursor,
      afterOrdinal: currentAfterOrdinal,
      ...(reset ? { reset: true } : {}),
    }
  }
}

export const teamService = new TeamService()
