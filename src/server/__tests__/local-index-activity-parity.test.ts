import { afterEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createActivityIndex,
  writeActivityProjection,
} from '../services/localIndex/activityIndex.js'
import { openLocalIndexDatabase } from '../services/localIndex/database.js'
import { createLocalIndexCoordinator } from '../services/localIndex/coordinator.js'
import { aggregateActivityStatsForMode } from '../api/activityStats.js'
import type { LocalIndexGateway } from '../services/localIndex/sessionIndex.js'
import { aggregateClaudeCodeStatsForRange } from '../../utils/stats.js'
import type {
  ReconciliationWatcher,
  ReconciliationWatcherOptions,
} from '../services/localIndex/reconciliationWatcher.js'
import { reduceTranscriptWithLocators } from '../services/localIndex/transcriptReducer.js'
import type { TranscriptChunk } from '../services/localIndex/types.js'

const tempDirs: string[] = []
const FIXED_NOW = new Date('2026-07-15T12:00:00.000Z')

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path =>
    rm(path, { recursive: true, force: true })))
})

function user(uuid: string, timestamp: string, isSidechain = false) {
  return {
    type: 'user',
    uuid,
    timestamp,
    isSidechain,
    message: { role: 'user', content: 'hello' },
  }
}

function assistant(
  uuid: string,
  timestamp: string,
  usage: Record<string, number>,
  options: { isSidechain?: boolean; tools?: unknown[] } = {},
) {
  return {
    type: 'assistant',
    uuid,
    timestamp,
    isSidechain: options.isSidechain ?? false,
    message: {
      role: 'assistant',
      model: 'claude-test',
      usage,
      content: options.tools ?? [],
    },
  }
}

function chunks(entries: unknown[]): TranscriptChunk[] {
  let byteStart = 0
  return entries.map(entry => {
    const text = `${JSON.stringify(entry)}\n`
    const chunk = {
      text,
      byteStart,
      byteLength: Buffer.byteLength(text),
      completeLine: true,
    }
    byteStart += chunk.byteLength
    return chunk
  })
}

function project(entries: unknown[], isSubagent = false) {
  const projection = reduceTranscriptWithLocators(
    chunks(entries),
    undefined,
    { isSubagent },
  ).projection
  if (!projection.activity) throw new Error('activity projection missing')
  return projection
}

async function withIndex(options: { shotStatsEnabled?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-index-'))
  tempDirs.push(root)
  const database = openLocalIndexDatabase({ path: join(root, 'index.sqlite') })
  const index = createActivityIndex(database, options)
  return { database, index }
}

function writeSource(
  database: ReturnType<typeof openLocalIndexDatabase>,
  path: string,
  parentSessionId: string,
  projection: ReturnType<typeof project>,
  isSubagent = false,
  mtimeMs = FIXED_NOW.getTime(),
) {
  database.transaction(operation => writeActivityProjection(operation, {
    path,
    parentSessionId,
    projectPath: 'test-project',
    isSubagent,
    fingerprint: {
      size: projection.indexedBytes,
      mtimeMs,
      fileIdentity: `fixture:${path}`,
      firstWindowHash: 'first',
      lastWindowHash: 'last',
      boundaryWindowHash: 'boundary',
      indexedBytes: projection.indexedBytes,
      parserVersion: 2,
    },
    fingerprintJson: '{}',
    indexedBytes: projection.indexedBytes,
    parserVersion: 2,
    state: 'ready',
    updatedAtMs: FIXED_NOW.getTime(),
  }, projection.activity!))
}

function speculation(timeSavedMs: number) {
  return { type: 'speculation-accept', timeSavedMs }
}

function shotAssistant(
  uuid: string,
  timestamp: string,
  shotCount: number,
  isSidechain = false,
) {
  return assistant(uuid, timestamp, {}, {
    isSidechain,
    tools: [{
      type: 'tool_use',
      name: 'Bash',
      input: { command: `gh pr create --body "${shotCount}-shotted by claude-test"` },
    }],
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await Bun.sleep(5)
  }
}

describe('local index activity parity', () => {
  it('routes off, shadow, and on without reading an unready index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-modes-'))
    tempDirs.push(root)
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    let indexedReads = 0
    const indexedStats = (await withIndex())
    const indexed = indexedStats.index.aggregateActivity('all', FIXED_NOW)
    const gateway = (mode: 'off' | 'shadow' | 'on', ready: boolean) => ({
      getMode: () => mode,
      isActivityScopeReady: () => ready,
      getActivityStats: () => {
        indexedReads += 1
        return { ...indexed, totalSessions: 99 }
      },
    }) as LocalIndexGateway
    try {
      expect((await aggregateActivityStatsForMode(
        '7d',
        FIXED_NOW,
        gateway('off', true),
      )).totalSessions).toBe(0)
      expect(indexedReads).toBe(0)

      expect((await aggregateActivityStatsForMode(
        '7d',
        FIXED_NOW,
        gateway('on', false),
      )).totalSessions).toBe(0)
      expect(indexedReads).toBe(0)

      expect((await aggregateActivityStatsForMode(
        '7d',
        FIXED_NOW,
        gateway('shadow', true),
      )).totalSessions).toBe(0)
      expect(indexedReads).toBe(1)

      expect((await aggregateActivityStatsForMode(
        '7d',
        FIXED_NOW,
        gateway('on', true),
      )).totalSessions).toBe(99)
      expect(indexedReads).toBe(2)

      expect((await aggregateActivityStatsForMode(
        'all',
        FIXED_NOW,
        gateway('on', true),
        async () => true,
      )).totalSessions).toBe(0)
      expect(indexedReads).toBe(2)

      expect((await aggregateActivityStatsForMode(
        'all',
        FIXED_NOW,
        gateway('on', true),
        async () => false,
      )).totalSessions).toBe(99)
      expect(indexedReads).toBe(3)
    } finally {
      indexedStats.database.close()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('coalesces file fallbacks only within the active config scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-fallback-scope-'))
    tempDirs.push(root)
    const firstConfigDir = join(root, 'first')
    const secondConfigDir = join(root, 'second')
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    const gateway = { getMode: () => 'off' as const } as LocalIndexGateway

    const seedConfig = async (configDir: string, sessionCount: number) => {
      const projectDir = join(configDir, 'projects', 'test-project')
      await mkdir(projectDir, { recursive: true })
      for (let index = 0; index < sessionCount; index += 1) {
        const transcriptPath = join(projectDir, `session-${index}.jsonl`)
        await writeFile(
          transcriptPath,
          chunks([
            user(`session-${index}-user`, '2026-07-15T10:00:00.000Z'),
          ]).map(chunk => chunk.text).join(''),
        )
        await utimes(transcriptPath, FIXED_NOW, FIXED_NOW)
      }
    }

    await seedConfig(firstConfigDir, 1)
    await seedConfig(secondConfigDir, 2)

    try {
      process.env.CLAUDE_CONFIG_DIR = firstConfigDir
      const firstScope = aggregateActivityStatsForMode('7d', FIXED_NOW, gateway)
      process.env.CLAUDE_CONFIG_DIR = secondConfigDir
      const secondScope = aggregateActivityStatsForMode('7d', FIXED_NOW, gateway)

      const [firstResult, secondResult] = await Promise.all([
        firstScope,
        secondScope,
      ])
      expect(firstResult.totalSessions).toBe(1)
      expect(secondResult.totalSessions).toBe(2)
      expect(secondResult).not.toBe(firstResult)

      process.env.CLAUDE_CONFIG_DIR = firstConfigDir
      const sameScopeFirst = aggregateActivityStatsForMode('7d', FIXED_NOW, gateway)
      const sameScopeSecond = aggregateActivityStatsForMode('7d', FIXED_NOW, gateway)
      const [sameScopeFirstResult, sameScopeSecondResult] = await Promise.all([
        sameScopeFirst,
        sameScopeSecond,
      ])
      expect(sameScopeSecondResult).toBe(sameScopeFirstResult)
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('uses independent activity readiness without admitting subagents to the sidebar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-coordinator-'))
    tempDirs.push(root)
    const configDir = join(root, 'config')
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    const projectDir = join(configDir, 'projects', 'test-project')
    const parentPath = join(projectDir, 'parent.jsonl')
    const subagentPath = join(projectDir, 'parent', 'subagents', 'agent-001.jsonl')
    await mkdir(join(projectDir, 'parent', 'subagents'), { recursive: true })
    await writeFile(parentPath, chunks([
      user('parent-user', '2026-07-15T10:00:00.000Z'),
      assistant('parent-assistant', '2026-07-15T10:01:00.000Z', {
        input_tokens: 1,
        output_tokens: 2,
      }),
    ]).map(chunk => chunk.text).join(''))
    await writeFile(subagentPath, chunks([
      user('agent-user', '2026-07-15T10:02:00.000Z', true),
      assistant('agent-assistant', '2026-07-15T10:03:00.000Z', {
        input_tokens: 3,
        output_tokens: 4,
      }, { isSidechain: true }),
    ]).map(chunk => chunk.text).join(''))
    await utimes(parentPath, FIXED_NOW, FIXED_NOW)
    await utimes(subagentPath, FIXED_NOW, FIXED_NOW)

    let watcherOptions!: ReconciliationWatcherOptions
    const watcher: ReconciliationWatcher = {
      async start() {},
      async stop() {},
      queueTranscriptPath() {},
      queueFullSweep() {},
      getMetrics: () => ({
        queuedPaths: 0,
        maxBatchSize: 0,
        yielded: 0,
        fullSweeps: 0,
        watchFailures: 0,
      }),
    }
    const coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'on', warningCode: null }),
      resolveScope: () => configDir,
      resolveDatabasePath: () => join(configDir, 'cc-haha', 'db', 'index-v1.sqlite'),
      createWatcher: options => {
        watcherOptions = options
        return watcher
      },
    })
    try {
      await coordinator.start()
      await waitFor(() => coordinator.isActivityScopeReady())

      expect(coordinator.listSessions({ limit: 10 }).total).toBe(1)
      expect(coordinator.getPublicStatus()).toMatchObject({
        discovered: 1,
        indexed: 1,
      })
      expect(coordinator.getActivityStats('all', FIXED_NOW)).toMatchObject({
        totalSessions: 1,
        totalMessages: 2,
        dailyModelTokens: [{
          date: '2026-07-15',
          tokensByModel: { 'claude-test': 10 },
        }],
      })
      for (const range of ['7d', '30d'] as const) {
        expect(coordinator.getActivityStats(range, FIXED_NOW)).toEqual(
          await aggregateClaudeCodeStatsForRange(range, { now: FIXED_NOW }),
        )
      }

      const sizeBeforeRewrite = (await stat(subagentPath)).size
      await writeFile(subagentPath, chunks([
        user('agent-user', '2026-07-15T10:02:00.000Z', true),
        assistant('agent-assistant', '2026-07-15T10:03:00.000Z', {
          input_tokens: 8,
          output_tokens: 4,
        }, { isSidechain: true }),
      ]).map(chunk => chunk.text).join(''))
      await utimes(subagentPath, FIXED_NOW, FIXED_NOW)
      expect((await stat(subagentPath)).size).toBe(sizeBeforeRewrite)
      await watcherOptions.onBatch({ paths: [], fullSweep: true })
      expect(coordinator.getActivityStats('all', FIXED_NOW)?.dailyModelTokens).toEqual([{
        date: '2026-07-15',
        tokensByModel: { 'claude-test': 15 },
      }])
      expect(coordinator.listSessions({ limit: 10 }).total).toBe(1)

      await appendFile(subagentPath, chunks([
        assistant('agent-appended', '2026-07-15T10:04:00.000Z', {
          input_tokens: 1,
          output_tokens: 1,
        }, { isSidechain: true }),
      ]).map(chunk => chunk.text).join(''))
      await utimes(subagentPath, FIXED_NOW, FIXED_NOW)
      await watcherOptions.onBatch({ paths: [], fullSweep: true })
      expect(coordinator.getActivityStats('all', FIXED_NOW)?.dailyModelTokens).toEqual([{
        date: '2026-07-15',
        tokensByModel: { 'claude-test': 17 },
      }])

      await writeFile(subagentPath, chunks([
        user('agent-user', '2026-07-15T10:02:00.000Z', true),
      ]).map(chunk => chunk.text).join(''))
      await utimes(subagentPath, FIXED_NOW, FIXED_NOW)
      await watcherOptions.onBatch({ paths: [], fullSweep: true })
      expect(coordinator.getActivityStats('all', FIXED_NOW)?.dailyModelTokens).toEqual([{
        date: '2026-07-15',
        tokensByModel: { 'claude-test': 3 },
      }])

      await rm(subagentPath)
      await watcherOptions.onBatch({ paths: [], fullSweep: true })
      expect(coordinator.isActivityScopeReady()).toBe(true)
      expect(coordinator.getActivityStats('all', FIXED_NOW)?.dailyModelTokens).toEqual([{
        date: '2026-07-15',
        tokensByModel: { 'claude-test': 3 },
      }])
      expect(coordinator.listSessions({ limit: 10 }).total).toBe(1)
    } finally {
      await coordinator.stop()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('preserves range, parent-session, subagent, tool, skill, and model totals', async () => {
    const { database, index } = await withIndex()
    try {
      writeSource(database, '/main-old.jsonl', 'parent-old', project([
        user('old-user', '2026-06-01T23:55:00.000Z'),
        assistant('recent-assistant', '2026-07-14T00:05:00.000Z', {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        }, {
          tools: [
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'tool_use', name: 'Skill', input: { skill: 'frontend-design' } },
          ],
        }),
      ]))
      writeSource(database, '/main-new.jsonl', 'parent-new', project([
        user('new-user', '2026-07-15T10:00:00.000Z'),
        assistant('new-assistant', '2026-07-15T10:01:00.000Z', {
          input_tokens: 1,
          output_tokens: 2,
        }),
      ]))
      writeSource(database, '/subagent.jsonl', 'parent-old', project([
        user('agent-user', '2026-07-14T00:06:00.000Z', true),
        assistant('agent-assistant', '2026-07-14T00:07:00.000Z', {
          input_tokens: 7,
          output_tokens: 8,
          cache_read_input_tokens: 9,
        }, {
          isSidechain: true,
          tools: [{ type: 'tool_use', name: 'Skill', input: { skill: 'frontend-design' } }],
        }),
      ], true), true)

      const sevenDays = index.aggregateActivity('7d', FIXED_NOW)
      expect(sevenDays.totalSessions).toBe(1)
      expect(sevenDays.totalMessages).toBe(2)
      expect(sevenDays.dailyActivity).toEqual([
        { date: '2026-07-14', messageCount: 1, sessionCount: 1, toolCallCount: 3 },
        { date: '2026-07-15', messageCount: 2, sessionCount: 1, toolCallCount: 0 },
      ])
      expect(sevenDays.dailyModelTokens).toEqual([
        { date: '2026-07-14', tokensByModel: { 'claude-test': 124 } },
        { date: '2026-07-15', tokensByModel: { 'claude-test': 3 } },
      ])
      expect(sevenDays.modelUsage['claude-test']).toEqual({
        inputTokens: 18,
        outputTokens: 30,
        cacheReadInputTokens: 39,
        cacheCreationInputTokens: 40,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      })
      expect(sevenDays.toolUsage).toEqual({ Bash: 1, Skill: 2 })
      expect(sevenDays.skillUsage).toEqual({ 'frontend-design': 2 })
      expect(index.aggregateActivity('30d', FIXED_NOW)).toEqual(sevenDays)

      const all = index.aggregateActivity('all', FIXED_NOW)
      expect(all.totalSessions).toBe(2)
      expect(all.totalMessages).toBe(4)
      expect(all.dailyActivity.find(day => day.date === '2026-06-01')).toEqual({
        date: '2026-06-01',
        messageCount: 1,
        sessionCount: 1,
        toolCallCount: 0,
      })
    } finally {
      database.close()
    }
  })

  it('matches canonical user, assistant, attachment, and system message semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-message-types-'))
    tempDirs.push(root)
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    const projectDir = join(root, 'projects', 'test-project')
    const transcriptPath = join(projectDir, 'typed-messages.jsonl')
    const entries = [
      user('typed-user', '2026-07-15T00:00:00.000Z'),
      {
        type: 'attachment',
        uuid: 'typed-attachment',
        timestamp: '2026-07-15T00:01:00.000Z',
        isSidechain: false,
      },
      assistant('typed-assistant', '2026-07-15T00:02:00.000Z', {
        input_tokens: 2,
        output_tokens: 3,
      }),
      {
        type: 'system',
        uuid: 'typed-system',
        timestamp: '2026-07-15T00:03:00.000Z',
        isSidechain: false,
        subtype: 'local_command',
        content: '<local-command-stdout>done</local-command-stdout>',
      },
    ]
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      transcriptPath,
      chunks(entries).map(chunk => chunk.text).join(''),
    )

    const { database, index } = await withIndex()
    try {
      writeSource(
        database,
        transcriptPath,
        'typed-messages',
        project(entries),
      )
      const canonical = await aggregateClaudeCodeStatsForRange('7d', {
        now: FIXED_NOW,
      })
      const indexed = index.aggregateActivity('7d', FIXED_NOW)

      expect(canonical).toMatchObject({
        totalSessions: 1,
        totalMessages: 4,
        longestSession: {
          duration: 180_000,
          messageCount: 4,
        },
        dailyActivity: [{
          date: '2026-07-15',
          messageCount: 4,
          sessionCount: 1,
          toolCallCount: 0,
        }],
      })
      expect(indexed).toEqual(canonical)
    } finally {
      database.close()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('uses the canonical unknown-model fallback for empty model names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-empty-model-'))
    tempDirs.push(root)
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    const projectDir = join(root, 'projects', 'test-project')
    const transcriptPath = join(projectDir, 'empty-model.jsonl')
    const emptyModelAssistant = assistant(
      'empty-model-assistant',
      '2026-07-15T10:01:00.000Z',
      { input_tokens: 1 },
    )
    emptyModelAssistant.message.model = ''
    const entries = [
      user('empty-model-user', '2026-07-15T10:00:00.000Z'),
      emptyModelAssistant,
    ]
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      transcriptPath,
      chunks(entries).map(chunk => chunk.text).join(''),
    )
    await utimes(transcriptPath, FIXED_NOW, FIXED_NOW)

    const { database, index } = await withIndex()
    try {
      writeSource(
        database,
        transcriptPath,
        'empty-model',
        project(entries),
      )
      const canonical = await aggregateClaudeCodeStatsForRange('7d', {
        now: FIXED_NOW,
      })
      expect(canonical.modelUsage).toHaveProperty('unknown')
      expect(canonical.dailyModelTokens).toEqual([{
        date: '2026-07-15',
        tokensByModel: { unknown: 1 },
      }])
      expect(index.aggregateActivity('7d', FIXED_NOW)).toEqual(canonical)
    } finally {
      database.close()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('differentially matches bounded canonical semantics across source and message edges', async () => {
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    const entryTypes = ['user', 'assistant', 'attachment', 'system'] as const
    const timestampModes = ['valid', 'invalid', 'out-of-order'] as const

    try {
      for (const isSubagent of [false, true]) {
        for (const isSidechain of [false, true]) {
          for (const timestampMode of timestampModes) {
            const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-differential-'))
            tempDirs.push(root)
            process.env.CLAUDE_CONFIG_DIR = root
            const projectDir = join(root, 'projects', 'test-project')
            const { database, index } = await withIndex()
            try {
              for (const [typeIndex, entryType] of entryTypes.entries()) {
                for (const sourceAge of ['recent', 'old'] as const) {
                  const parentSessionId = [
                    isSubagent ? 'subagent' : 'main',
                    isSidechain ? 'sidechain' : 'primary',
                    timestampMode,
                    entryType,
                    sourceAge,
                  ].join('-')
                  const transcriptPath = isSubagent
                    ? join(
                        projectDir,
                        parentSessionId,
                        'subagents',
                        `agent-${entryType}-${sourceAge}.jsonl`,
                      )
                    : join(projectDir, `${parentSessionId}.jsonl`)
                  const firstTimestamp = timestampMode === 'invalid'
                    ? 'not-a-timestamp'
                    : '2026-07-15T04:00:00.000Z'
                  const durationMs = (entryTypes.length - typeIndex) * 60_000
                  const lastTimestamp = timestampMode === 'out-of-order'
                    ? new Date(
                        Date.parse('2026-07-15T04:00:00.000Z') - durationMs,
                      ).toISOString()
                    : new Date(
                        Date.parse('2026-07-15T04:00:00.000Z') + durationMs,
                      ).toISOString()
                  const firstEntry = entryType === 'assistant'
                    ? assistant(
                        `${parentSessionId}-first`,
                        firstTimestamp,
                        { input_tokens: 1, output_tokens: 2 },
                        { isSidechain },
                      )
                    : entryType === 'user'
                      ? user(`${parentSessionId}-first`, firstTimestamp, isSidechain)
                      : {
                          type: entryType,
                          uuid: `${parentSessionId}-first`,
                          timestamp: firstTimestamp,
                          isSidechain,
                        }
                  const entries = [
                    firstEntry,
                    assistant(
                      `${parentSessionId}-last`,
                      lastTimestamp,
                      {
                        input_tokens: typeIndex + 1,
                        output_tokens: typeIndex + 2,
                        cache_read_input_tokens: typeIndex + 3,
                        cache_creation_input_tokens: typeIndex + 4,
                      },
                      {
                        isSidechain,
                        tools: [{
                          type: 'tool_use',
                          name: 'Skill',
                          input: { skill: `skill-${entryType}` },
                        }],
                      },
                    ),
                  ]
                  await mkdir(join(transcriptPath, '..'), { recursive: true })
                  await writeFile(
                    transcriptPath,
                    chunks(entries).map(chunk => chunk.text).join(''),
                  )
                  const sourceMtime = sourceAge === 'recent'
                    ? new Date('2026-07-15T08:00:00.000Z')
                    : new Date('2026-06-01T08:00:00.000Z')
                  await utimes(transcriptPath, sourceMtime, sourceMtime)
                  writeSource(
                    database,
                    transcriptPath,
                    parentSessionId,
                    project(entries, isSubagent),
                    isSubagent,
                    sourceMtime.getTime(),
                  )
                }
              }

              for (const range of ['7d', '30d'] as const) {
                expect(index.aggregateActivity(range, FIXED_NOW)).toEqual(
                  await aggregateClaudeCodeStatsForRange(range, { now: FIXED_NOW }),
                )
              }
            } finally {
              database.close()
            }
          }
        }
      }
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('matches a fresh all-time cache split across historical, today, and future sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-all-fresh-'))
    tempDirs.push(root)
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const yesterdayValue = new Date(now)
    yesterdayValue.setDate(yesterdayValue.getDate() - 1)
    const yesterday = yesterdayValue.toISOString().slice(0, 10)
    const tomorrowValue = new Date(now)
    tomorrowValue.setDate(tomorrowValue.getDate() + 1)
    const tomorrow = tomorrowValue.toISOString().slice(0, 10)
    const projectDir = join(root, 'projects', 'test-project')
    const fixtures = [
      {
        id: 'historical-old-mtime',
        timestamp: `${yesterday}T12:00:00.000Z`,
        mtime: `${yesterday}T08:00:00.000Z`,
        speculation: 100,
      },
      {
        id: 'today-recent-mtime',
        timestamp: `${today}T12:00:00.000Z`,
        mtime: `${today}T08:00:00.000Z`,
        speculation: 10,
      },
      {
        id: 'today-old-mtime',
        timestamp: `${today}T13:00:00.000Z`,
        mtime: `${yesterday}T08:00:00.000Z`,
        speculation: 20,
      },
      {
        id: 'future-recent-mtime',
        timestamp: `${tomorrow}T12:00:00.000Z`,
        mtime: `${today}T09:00:00.000Z`,
        speculation: 30,
      },
    ]
    await mkdir(projectDir, { recursive: true })
    const { database, index } = await withIndex()
    try {
      for (const fixture of fixtures) {
        const transcriptPath = join(projectDir, `${fixture.id}.jsonl`)
        const entries = [
          user(`${fixture.id}-user`, fixture.timestamp),
          speculation(fixture.speculation),
        ]
        await writeFile(
          transcriptPath,
          chunks(entries).map(chunk => chunk.text).join(''),
        )
        const sourceMtime = new Date(fixture.mtime)
        await utimes(transcriptPath, sourceMtime, sourceMtime)
        writeSource(
          database,
          transcriptPath,
          fixture.id,
          project(entries),
          false,
          sourceMtime.getTime(),
        )
      }

      const canonical = await aggregateClaudeCodeStatsForRange('all', { now })
      expect(canonical).toMatchObject({
        totalSessions: 2,
        totalMessages: 2,
        totalSpeculationTimeSavedMs: 200,
      })
      expect(index.aggregateActivity('all', now)).toEqual(canonical)
    } finally {
      database.close()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('uses canonical source-mtime eligibility for source-wide speculation totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-speculation-'))
    tempDirs.push(root)
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    const projectDir = join(root, 'projects', 'test-project')
    const oldPath = join(projectDir, 'old.jsonl')
    const recentPath = join(projectDir, 'recent.jsonl')
    const oldEntries = [
      user('old-user', '2026-06-01T00:00:00.000Z'),
      speculation(123),
    ]
    const recentEntries = [
      user('recent-user', '2026-07-15T00:00:00.000Z'),
      speculation(7),
    ]
    const oldMtime = new Date('2026-06-01T00:00:00.000Z')
    const recentMtime = new Date('2026-07-15T00:00:00.000Z')
    await mkdir(projectDir, { recursive: true })
    await writeFile(oldPath, chunks(oldEntries).map(chunk => chunk.text).join(''))
    await writeFile(recentPath, chunks(recentEntries).map(chunk => chunk.text).join(''))
    await utimes(oldPath, oldMtime, oldMtime)
    await utimes(recentPath, recentMtime, recentMtime)

    const { database, index } = await withIndex()
    try {
      writeSource(database, oldPath, 'old', project(oldEntries), false, oldMtime.getTime())
      writeSource(
        database,
        recentPath,
        'recent',
        project(recentEntries),
        false,
        recentMtime.getTime(),
      )
      for (const range of ['7d', '30d'] as const) {
        const canonical = await aggregateClaudeCodeStatsForRange(range, { now: FIXED_NOW })
        expect(index.aggregateActivity(range, FIXED_NOW).totalSpeculationTimeSavedMs)
          .toBe(canonical.totalSpeculationTimeSavedMs)
        expect(canonical.totalSpeculationTimeSavedMs).toBe(7)
      }
      expect(index.aggregateActivity('all', FIXED_NOW).totalSpeculationTimeSavedMs).toBe(137)
    } finally {
      database.close()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('projects existing SHOT_STATS fields once per parent with main-before-subagent precedence', async () => {
    const { database, index } = await withIndex({ shotStatsEnabled: true })
    try {
      writeSource(database, '/parent-main.jsonl', 'parent', project([
        user('main-user', '2026-07-15T00:00:00.000Z'),
        shotAssistant('main-shot', '2026-07-15T00:01:00.000Z', 2, true),
      ]))
      writeSource(database, '/parent-subagent.jsonl', 'parent', project([
        shotAssistant('subagent-duplicate', '2026-07-15T00:02:00.000Z', 1, true),
      ], true), true)
      writeSource(database, '/other-subagent.jsonl', 'other', project([
        shotAssistant('subagent-only', '2026-07-15T00:03:00.000Z', 1, true),
      ], true), true)
      writeSource(
        database,
        '/old-main.jsonl',
        'old',
        project([
          user('old-user', '2026-06-01T00:00:00.000Z'),
          shotAssistant('old-shot', '2026-06-01T00:01:00.000Z', 3),
        ]),
        false,
        new Date('2026-06-01T00:00:00.000Z').getTime(),
      )

      expect(index.aggregateActivity('7d', FIXED_NOW)).toMatchObject({
        shotDistribution: { 1: 1, 2: 1 },
        oneShotRate: 50,
      })
      expect(index.aggregateActivity('all', FIXED_NOW)).toMatchObject({
        shotDistribution: { 1: 2, 2: 2, 3: 1 },
        oneShotRate: 40,
      })

      writeSource(database, '/parent-main.jsonl', 'parent', project([
        user('main-user', '2026-07-15T00:00:00.000Z'),
        shotAssistant('main-rewritten', '2026-07-15T00:01:00.000Z', 4, true),
      ]))
      expect(index.aggregateActivity('7d', FIXED_NOW).shotDistribution).toEqual({
        1: 1,
        4: 1,
      })

      database.transaction(operation => {
        operation.run(
          'DELETE FROM activity_sources WHERE path = ?',
          '/parent-main.jsonl',
        )
      })
      expect(index.aggregateActivity('7d', FIXED_NOW).shotDistribution).toEqual({
        1: 2,
      })
    } finally {
      database.close()
    }
  })

  it('matches canonical empty-source SHOT_STATS response shapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-activity-empty-shot-'))
    tempDirs.push(root)
    const previousConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    const { database, index } = await withIndex()
    try {
      expect(index.aggregateActivity('all', FIXED_NOW)).toEqual(
        await aggregateClaudeCodeStatsForRange('all', { now: FIXED_NOW }),
      )
      expect(index.aggregateActivity('7d', FIXED_NOW)).toEqual(
        await aggregateClaudeCodeStatsForRange('7d', { now: FIXED_NOW }),
      )

      const projectDir = join(root, 'projects', 'test-project')
      const transcriptPath = join(projectDir, 'progress-only.jsonl')
      const entries = [{
        type: 'progress',
        uuid: 'progress-only',
        timestamp: '2026-07-15T10:00:00.000Z',
      }]
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        transcriptPath,
        chunks(entries).map(chunk => chunk.text).join(''),
      )
      await utimes(transcriptPath, FIXED_NOW, FIXED_NOW)
      writeSource(
        database,
        transcriptPath,
        'progress-only',
        project(entries),
      )
      expect(index.aggregateActivity('all', FIXED_NOW)).toEqual(
        await aggregateClaudeCodeStatsForRange('all', { now: FIXED_NOW }),
      )
    } finally {
      database.close()
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfig
    }
  })

  it('replaces and deletes only the affected source contribution', async () => {
    const { database, index } = await withIndex()
    try {
      writeSource(database, '/first.jsonl', 'first', project([
        user('first-user', '2026-07-15T10:00:00.000Z'),
      ]))
      writeSource(database, '/second.jsonl', 'second', project([
        user('second-user', '2026-07-15T11:00:00.000Z'),
      ]))
      expect(index.aggregateActivity('all', FIXED_NOW).totalMessages).toBe(2)

      writeSource(database, '/first.jsonl', 'first', project([
        user('first-rewritten', '2026-07-15T10:00:00.000Z'),
        assistant('first-added', '2026-07-15T10:01:00.000Z', {
          input_tokens: 1,
        }),
      ]))
      expect(index.aggregateActivity('all', FIXED_NOW).totalMessages).toBe(3)

      database.write(operation => {
        operation.run('DELETE FROM activity_sources WHERE path = ?', '/first.jsonl')
      })
      const afterDelete = index.aggregateActivity('all', FIXED_NOW)
      expect(afterDelete.totalMessages).toBe(1)
      expect(afterDelete.totalSessions).toBe(1)
    } finally {
      database.close()
    }
  })

  it('answers a warm 10k-session query from aggregate rows with a bounded plan', async () => {
    const { database, index } = await withIndex()
    try {
      database.transaction(operation => {
        for (let value = 0; value < 10_000; value += 1) {
          const path = `/missing/transcript-${value}.jsonl`
          const sessionId = `session-${value}`
          operation.run(`
            INSERT INTO activity_sources (
              path, parent_session_id, project_path, is_subagent, size_bytes,
              mtime_ms, file_identity, prefix_hash, indexed_bytes,
              parser_version, state, last_error_code, updated_at_ms
            ) VALUES (?, ?, 'project', 0, 1, ?, NULL, '{}', 1, 2, 'ready', NULL, 1)
          `, path, sessionId, FIXED_NOW.getTime())
          operation.run(`
            INSERT INTO activity_sessions (
              transcript_path, session_id, first_timestamp, last_timestamp,
              duration_ms, message_count, start_hour,
              speculation_time_saved_ms, shot_count
            ) VALUES (?, ?, '2026-07-15T00:00:00.000Z',
              '2026-07-15T00:00:01.000Z', 1000, 1, 0, 0, NULL)
          `, path, sessionId)
          operation.run(`
            INSERT INTO activity_daily (
              transcript_path, date, message_count, tool_call_count
            ) VALUES (?, '2026-07-15', 1, 0)
          `, path)
        }
      })

      const stats = index.aggregateActivity('all', FIXED_NOW)
      expect(stats.totalSessions).toBe(10_000)
      expect(stats.totalMessages).toBe(10_000)
      expect(stats.dailyActivity).toEqual([{
        date: '2026-07-15',
        messageCount: 10_000,
        sessionCount: 10_000,
        toolCallCount: 0,
      }])
      expect(index.explainAggregatePlan('7d', FIXED_NOW).join('\n')).toContain(
        'activity_daily_date_idx',
      )
    } finally {
      database.close()
    }
  }, 15_000)
})
