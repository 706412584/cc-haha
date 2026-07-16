import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  open,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export type LocalIndexCorpusOptions = {
  rootDir: string
  sessions: number
  entriesPerSession: number
  largeTranscriptBytes?: number
  seed: number
}

export type LocalIndexCorpus = {
  configDir: string
  projectsDir: string
  transcriptPaths: string[]
  manifestPath: string
}

type JsonRecord = Record<string, unknown>

type SessionSummary = {
  sourcePath: string
  sessionId: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
}

type SourceManifestEntry = {
  path: string
  bytes: number
  sha256: string
}

const PROJECT_COUNT = 8
const LARGE_RECORD_CHUNK_BYTES = 1024 * 1024
const SYNTHETIC_MODEL = 'claude-synthetic-benchmark'

export type BufferWriter = {
  write: (
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => Promise<{ bytesWritten: number }>
}

export async function writeBufferFully(
  writer: BufferWriter,
  buffer: Uint8Array,
): Promise<number> {
  let offset = 0
  while (offset < buffer.byteLength) {
    const remaining = buffer.byteLength - offset
    const { bytesWritten } = await writer.write(buffer, offset, remaining)
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten < 1 ||
      bytesWritten > remaining
    ) {
      throw new Error(`invalid short-write result: ${bytesWritten} of ${remaining} bytes`)
    }
    offset += bytesWritten
  }
  return offset
}

function assertOptions(options: LocalIndexCorpusOptions): void {
  if (!options.rootDir.trim()) {
    throw new Error('rootDir must not be empty')
  }
  if (!Number.isSafeInteger(options.sessions) || options.sessions < 1) {
    throw new Error('sessions must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(options.entriesPerSession) ||
    options.entriesPerSession < 6
  ) {
    throw new Error('entriesPerSession must be a safe integer of at least 6')
  }
  if (!Number.isSafeInteger(options.seed)) {
    throw new Error('seed must be a safe integer')
  }
  if (
    options.largeTranscriptBytes !== undefined &&
    (!Number.isSafeInteger(options.largeTranscriptBytes) ||
      options.largeTranscriptBytes < 0)
  ) {
    throw new Error('largeTranscriptBytes must be a non-negative safe integer')
  }
}

function seededHex(seed: number, label: string): string {
  return createHash('sha256')
    .update(`cc-haha-local-index:${seed}:${label}`)
    .digest('hex')
}

function sessionIdFor(seed: number, index: number): string {
  const hex = seededHex(seed, `session:${index}`)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

function entryId(seed: number, sessionIndex: number, label: string): string {
  return sessionIdFor(seed, sessionIndex * 100 + Number.parseInt(
    seededHex(seed, label).slice(0, 6),
    16,
  ))
}

function timestampFor(seed: number, sessionIndex: number, offsetSeconds: number): string {
  const seedDayOffset = Math.abs(seed) % 300
  const timestamp =
    Date.UTC(2025, 0, 1 + seedDayOffset) +
    sessionIndex * 60_000 +
    offsetSeconds * 1000
  return new Date(timestamp).toISOString()
}

function projectIndexFor(sessionIndex: number, sessions: number): number {
  if (sessions > 1 && sessionIndex === sessions - 1) {
    return 1
  }
  return sessionIndex % PROJECT_COUNT
}

function projectDirFor(projectIndex: number): string {
  return `-synthetic-local-index-project-${projectIndex.toString().padStart(2, '0')}`
}

function syntheticWorkDir(projectIndex: number): string {
  return `/synthetic/local-index/project-${projectIndex.toString().padStart(2, '0')}`
}

function messageUsage(sessionIndex: number): {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
} {
  return {
    input_tokens: 10 + sessionIndex % 5,
    output_tokens: 4 + sessionIndex % 3,
    cache_read_input_tokens: sessionIndex % 7,
    cache_creation_input_tokens: sessionIndex % 2,
  }
}

function usageTotal(usage: ReturnType<typeof messageUsage>): number {
  return Object.values(usage).reduce((total, value) => total + value, 0)
}

function userRecord(
  seed: number,
  sessionIndex: number,
  sessionId: string,
  workDir: string,
  currentShape: boolean,
): JsonRecord {
  const text = currentShape
    ? `Synthetic current-shape prompt ${sessionIndex}`
    : `Synthetic old-shape prompt ${sessionIndex}`
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: currentShape ? [{ type: 'text', text }] : text,
    },
    uuid: entryId(seed, sessionIndex, 'user'),
    timestamp: timestampFor(seed, sessionIndex, 10),
    userType: 'external',
    cwd: workDir,
    sessionId,
  }
}

function assistantRecord(
  seed: number,
  sessionIndex: number,
  parentUuid: string,
  content: Array<Record<string, unknown>> = [{
    type: 'text',
    text: `Synthetic assistant response ${sessionIndex}`,
  }],
  offsetSeconds = 20,
): JsonRecord {
  return {
    parentUuid,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: SYNTHETIC_MODEL,
      id: `msg_${seededHex(seed, `message:${sessionIndex}:${offsetSeconds}`).slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content,
      usage: messageUsage(sessionIndex),
    },
    uuid: entryId(seed, sessionIndex, `assistant:${offsetSeconds}`),
    timestamp: timestampFor(seed, sessionIndex, offsetSeconds),
  }
}

function sourcePath(configDir: string, filePath: string): string {
  return relative(configDir, filePath).split(sep).join('/')
}

async function streamLargeTranscript(
  filePath: string,
  requestedBytes: number,
): Promise<number> {
  let currentBytes = (await stat(filePath)).size
  if (currentBytes >= requestedBytes) return currentBytes

  const record = Buffer.from(`${JSON.stringify({
    type: 'progress',
    marker: 'synthetic-large-record',
    data: 'x'.repeat(960),
  })}\n`)
  const recordsPerChunk = Math.max(
    1,
    Math.floor(LARGE_RECORD_CHUNK_BYTES / record.length),
  )
  const chunk = Buffer.concat(Array.from({ length: recordsPerChunk }, () => record))
  const handle = await open(filePath, 'a')
  try {
    while (currentBytes + chunk.length < requestedBytes) {
      currentBytes += await writeBufferFully(handle, chunk)
    }
    while (currentBytes < requestedBytes) {
      currentBytes += await writeBufferFully(handle, record)
    }
  } finally {
    await handle.close()
  }
  return currentBytes
}

async function hashSource(configDir: string, filePath: string): Promise<SourceManifestEntry> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(buffer)
    bytes += buffer.length
  }
  return {
    path: sourcePath(configDir, filePath),
    bytes,
    sha256: hash.digest('hex'),
  }
}

export async function createLocalIndexCorpus(
  options: LocalIndexCorpusOptions,
): Promise<LocalIndexCorpus> {
  assertOptions(options)

  const rootDir = resolve(options.rootDir)
  const configDir = join(rootDir, 'home', '.claude')
  const projectsDir = join(configDir, 'projects')
  const manifestPath = join(rootDir, 'local-index-corpus-manifest.json')
  const largeTranscriptBytes = options.largeTranscriptBytes ?? 0
  await mkdir(projectsDir, { recursive: true })

  const transcriptPaths: string[] = []
  const sourcePaths: string[] = []
  const summaries: SessionSummary[] = []
  const featureCounts = {
    duplicateSessionIds: [] as string[],
    malformedCompleteLines: 0,
    incompleteFinalLines: 0,
    metadataOnlyAppends: 0,
    subagentTranscripts: 0,
    taskNotifications: 0,
    checkpoints: 0,
    windowsDriveMetadata: 0,
    uncMetadata: 0,
  }
  let activityMessages = 0
  let activityToolCalls = 0
  let activityTokens = 0

  const firstSessionId = sessionIdFor(options.seed, 0)
  if (options.sessions > 1) {
    featureCounts.duplicateSessionIds.push(firstSessionId)
  }

  for (let sessionIndex = 0; sessionIndex < options.sessions; sessionIndex += 1) {
    const projectIndex = projectIndexFor(sessionIndex, options.sessions)
    const projectDir = projectDirFor(projectIndex)
    const projectPath = join(projectsDir, projectDir)
    const isDuplicate = options.sessions > 1 && sessionIndex === options.sessions - 1
    const sessionId = isDuplicate
      ? firstSessionId
      : sessionIdFor(options.seed, sessionIndex)
    const filePath = join(projectPath, `${sessionId}.jsonl`)
    const kind = sessionIndex % PROJECT_COUNT
    let workDir = syntheticWorkDir(projectIndex)
    if (kind === 5) {
      workDir = 'C:\\Synthetic\\Corpus\\Project'
      featureCounts.windowsDriveMetadata += 1
    } else if (kind === 6) {
      workDir = '\\\\synthetic-server\\share\\corpus'
      featureCounts.uncMetadata += 1
    }
    await mkdir(projectPath, { recursive: true })

    const user = userRecord(
      options.seed,
      sessionIndex,
      sessionId,
      workDir,
      sessionIndex % 2 === 1,
    )
    const userUuid = user.uuid as string
    const baseAssistant = assistantRecord(
      options.seed,
      sessionIndex,
      userUuid,
    )
    const records: JsonRecord[] = [
      {
        type: 'session-meta',
        isMeta: true,
        workDir,
        timestamp: timestampFor(options.seed, sessionIndex, 0),
      },
      user,
      baseAssistant,
    ]
    for (let entryIndex = records.length; entryIndex < options.entriesPerSession; entryIndex += 1) {
      records.push({
        type: 'progress',
        marker: `synthetic-filler-${sessionIndex}-${entryIndex}`,
        timestamp: timestampFor(options.seed, sessionIndex, 20 + entryIndex),
      })
    }

    let messageCount = 2
    let modifiedAt = timestampFor(options.seed, sessionIndex, 20)
    activityMessages += 2
    activityTokens += usageTotal(messageUsage(sessionIndex))

    if (kind === 0) {
      records[records.length - 1] = {
        type: 'session-meta',
        isMeta: true,
        workDir,
        permissionMode: 'default',
        timestamp: timestampFor(options.seed, sessionIndex, 55),
      }
      featureCounts.metadataOnlyAppends += 1
    } else if (kind === 1) {
      const toolId = `toolu_${seededHex(options.seed, `tool:${sessionIndex}`).slice(0, 12)}`
      const toolAssistant = assistantRecord(
        options.seed,
        sessionIndex,
        baseAssistant.uuid as string,
        [{
          type: 'tool_use',
          id: toolId,
          name: 'Agent',
          input: { description: 'Synthetic subagent benchmark task' },
        }],
        30,
      )
      records[3] = toolAssistant
      records[4] = {
        parentUuid: toolAssistant.uuid,
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolId,
            content: `Synthetic subagent summary\nagentId: synthetic-${sessionIndex}`,
          }],
        },
        uuid: entryId(options.seed, sessionIndex, 'tool-result'),
        timestamp: timestampFor(options.seed, sessionIndex, 35),
      }
      messageCount += 2
      modifiedAt = timestampFor(options.seed, sessionIndex, 35)
      activityMessages += 2
      activityToolCalls += 1
      activityTokens += usageTotal(messageUsage(sessionIndex))

      const subagentDir = join(projectPath, sessionId, 'subagents')
      const subagentPath = join(subagentDir, `agent-synthetic-${sessionIndex}.jsonl`)
      await mkdir(subagentDir, { recursive: true })
      const subagentUserId = entryId(options.seed, sessionIndex, 'subagent-user')
      const subagentRecords = [
        {
          parentUuid: null,
          isSidechain: true,
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Synthetic subagent prompt' }],
          },
          uuid: subagentUserId,
          timestamp: timestampFor(options.seed, sessionIndex, 31),
        },
        {
          ...assistantRecord(
            options.seed,
            sessionIndex,
            subagentUserId,
            [{
              type: 'tool_use',
              id: `subtool_${sessionIndex}`,
              name: 'Read',
              input: { file_path: '/synthetic/fixture.ts' },
            }],
            32,
          ),
          isSidechain: true,
        },
      ]
      await writeFile(
        subagentPath,
        `${subagentRecords.map(record => JSON.stringify(record)).join('\n')}\n`,
      )
      await utimes(
        subagentPath,
        new Date(timestampFor(options.seed, sessionIndex, 32)),
        new Date(timestampFor(options.seed, sessionIndex, 32)),
      )
      sourcePaths.push(subagentPath)
      featureCounts.subagentTranscripts += 1
      activityMessages += subagentRecords.length
      activityToolCalls += 1
      activityTokens += usageTotal(messageUsage(sessionIndex))
    } else if (kind === 2) {
      const notificationId = entryId(options.seed, sessionIndex, 'task-notification')
      records[3] = {
        parentUuid: baseAssistant.uuid,
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification>\n<task-id>synthetic-bg</task-id>\n<tool-use-id>synthetic-tool</tool-use-id>\n<status>completed</status>\n<summary>Synthetic task completed</summary>\n</task-notification>',
        },
        uuid: notificationId,
        timestamp: timestampFor(options.seed, sessionIndex, 30),
      }
      records[4] = assistantRecord(
        options.seed,
        sessionIndex,
        notificationId,
        [{ type: 'text', text: 'Synthetic automatic task response' }],
        35,
      )
      messageCount += 2
      modifiedAt = timestampFor(options.seed, sessionIndex, 35)
      activityMessages += 2
      activityTokens += usageTotal(messageUsage(sessionIndex))
      featureCounts.taskNotifications += 1
    } else if (kind === 3) {
      records[3] = {
        type: 'file-history-snapshot',
        messageId: entryId(options.seed, sessionIndex, 'checkpoint-message'),
        snapshot: {
          messageId: userUuid,
          trackedFileBackups: {
            'src/synthetic.ts': {
              backupFileName: `synthetic-${sessionIndex}@v1`,
              version: 1,
              backupTime: timestampFor(options.seed, sessionIndex, 9),
            },
          },
          timestamp: timestampFor(options.seed, sessionIndex, 9),
        },
        isSnapshotUpdate: false,
      }
      featureCounts.checkpoints += 1
    }

    let contents: string
    if (kind === 4) {
      const lines = records.map(record => JSON.stringify(record))
      lines[lines.length - 2] = '{"type":"synthetic-malformed-complete-line",not-json}'
      lines[lines.length - 1] = '{"type":"synthetic-incomplete-final-line","message":'
      contents = lines.join('\n')
      featureCounts.malformedCompleteLines += 1
      featureCounts.incompleteFinalLines += 1
    } else {
      contents = `${records.map(record => JSON.stringify(record)).join('\n')}\n`
    }
    await writeFile(filePath, contents)
    await utimes(
      filePath,
      new Date(modifiedAt),
      new Date(modifiedAt),
    )

    transcriptPaths.push(filePath)
    sourcePaths.push(filePath)
    summaries.push({
      sourcePath: sourcePath(configDir, filePath),
      sessionId,
      title: sessionIndex % 2 === 1
        ? `Synthetic current-shape prompt ${sessionIndex}`
        : `Synthetic old-shape prompt ${sessionIndex}`,
      createdAt: timestampFor(options.seed, sessionIndex, 0),
      modifiedAt,
      messageCount,
    })
  }

  let largeTranscript: {
    sourcePath: string
    requestedBytes: number
    actualBytes: number
  } | null = null
  if (largeTranscriptBytes > 0) {
    const largePath = transcriptPaths.at(-1)!
    const actualBytes = await streamLargeTranscript(largePath, largeTranscriptBytes)
    largeTranscript = {
      sourcePath: sourcePath(configDir, largePath),
      requestedBytes: largeTranscriptBytes,
      actualBytes,
    }
  }

  summaries.sort((a, b) => {
    const timeDiff = Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)
    return timeDiff || a.sourcePath.localeCompare(b.sourcePath)
  })
  sourcePaths.sort((a, b) => sourcePath(configDir, a).localeCompare(sourcePath(configDir, b)))
  const sources: SourceManifestEntry[] = []
  for (const filePath of sourcePaths) {
    sources.push(await hashSource(configDir, filePath))
  }

  const manifest = {
    corpusVersion: 1,
    seed: options.seed,
    options: {
      sessions: options.sessions,
      entriesPerSession: options.entriesPerSession,
      largeTranscriptBytes,
      seed: options.seed,
    },
    features: featureCounts,
    expected: {
      normalizedSessionOrder: summaries.map(
        summary => `${summary.sessionId}@${summary.sourcePath}`,
      ),
      totals: {
        mainTranscriptFiles: transcriptPaths.length,
        sourceFiles: sources.length,
        visibleMessages: summaries.reduce(
          (total, summary) => total + summary.messageCount,
          0,
        ),
      },
      summaries,
      activityTotals: {
        sessions: transcriptPaths.length,
        messages: activityMessages,
        toolCalls: activityToolCalls,
        tokens: activityTokens,
      },
    },
    largeTranscript,
    sources,
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return {
    configDir,
    projectsDir,
    transcriptPaths,
    manifestPath,
  }
}
