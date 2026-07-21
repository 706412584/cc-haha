import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSearchContentDatabase } from './searchContentDatabase.js'
import {
  createSearchContentIndex,
  normalizeSearchContent,
  type SearchContentSourceWrite,
} from './searchContentIndex.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path =>
    rm(path, { recursive: true, force: true }),
  ))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-index-'))
  tempDirs.push(root)
  const database = openSearchContentDatabase({ path: join(root, 'search.sqlite') })
  const index = createSearchContentIndex(database, { scope: join(root, 'projects') })
  return { database, index }
}

function source(overrides: Partial<SearchContentSourceWrite> = {}): SearchContentSourceWrite {
  return {
    path: '/projects/-repo/session.jsonl',
    projectPath: '-repo',
    ownerSessionId: 'session',
    ownerTranscriptPath: '/projects/-repo/session.jsonl',
    modifiedAtMs: 200,
    sizeBytes: 300,
    mtimeMs: 200,
    fileIdentity: '1:2',
    fingerprint: 'fingerprint',
    indexedBytes: 300,
    indexedLines: 3,
    parserVersion: 1,
    state: 'ready',
    lastErrorCode: null,
    updatedAtMs: 200,
    ...overrides,
  }
}

describe('search content index', () => {
  it('returns null until the global projection is completely ready', async () => {
    const { database, index } = await setup()
    try {
      index.replaceSource(source(), [{
        jsonlLine: 1,
        byteStart: 0,
        byteLength: 100,
        segmentIndex: 0,
        role: 'user',
        messageId: 'u1',
        timestamp: null,
        body: '全文搜索 ready needle',
        normalizedBody: normalizeSearchContent('全文搜索 ready needle'),
      }])
      expect(index.query('needle')).toBeNull()

      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('needle')?.sessions).toHaveLength(1)

      index.setReadiness({
        state: 'degraded',
        discovered: 1,
        indexed: 0,
        degraded: 1,
        lastErrorCode: 'WATCHER_UNHEALTHY',
      })
      expect(index.query('needle')).toBeNull()
    } finally {
      database.close()
    }
  })

  it('throws runtime database failures so the coordinator can degrade explicitly', async () => {
    const { database, index } = await setup()
    index.setReadiness({ state: 'ready', discovered: 0, indexed: 0 })
    database.close()

    expect(() => index.query('needle')).toThrow('closed')
  })

  it('uses trigram for long queries, instr for short Chinese queries, and preserves original body', async () => {
    const { database, index } = await setup()
    try {
      index.replaceSource(source(), [
        {
          jsonlLine: 1,
          byteStart: 0,
          byteLength: 100,
          segmentIndex: 0,
          role: 'user',
          messageId: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          body: '请检查 SQLite 全文搜索',
          normalizedBody: normalizeSearchContent('请检查 SQLite 全文搜索'),
        },
        {
          jsonlLine: 2,
          byteStart: 100,
          byteLength: 100,
          segmentIndex: 0,
          role: 'assistant',
          messageId: 'a1',
          timestamp: null,
          body: 'literal .* [needle] and A"B marker',
          normalizedBody: normalizeSearchContent('literal .* [needle] and A"B marker'),
        },
      ])
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })

      expect(index.query('SQLite')?.sessions[0]?.matches[0]).toMatchObject({
        sourcePath: source().path,
        ownerSessionId: 'session',
        ownerTranscriptPath: source().ownerTranscriptPath,
        projectPath: '-repo',
        lineNumber: 1,
        role: 'user',
        messageId: 'u1',
        body: '请检查 SQLite 全文搜索',
        byteStart: 0,
        byteLength: 100,
        sourceSizeBytes: 300,
        sourceMtimeMs: 200,
        sourceFileIdentity: '1:2',
        sourceFingerprint: 'fingerprint',
        sourceIndexedBytes: 300,
        sourceParserVersion: 1,
      })
      expect(index.query('搜索')?.sessions[0]?.matches[0].lineNumber).toBe(1)
      expect(index.query('sqlite')?.sessions).toHaveLength(1)
      expect(index.query('sqlite', { caseSensitive: true })?.sessions).toEqual([])
      expect(index.query('SQLite', { caseSensitive: true })?.sessions).toHaveLength(1)
      expect(index.query('.* [needle]')?.sessions[0]?.matches[0].lineNumber).toBe(2)
      expect(index.query('A"B')?.sessions[0]?.matches[0].lineNumber).toBe(2)
      expect(index.query('missing')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })

  it('throws an FTS runtime failure instead of disguising it as not ready', async () => {
    const { database, index } = await setup()
    try {
      index.setReadiness({ state: 'ready', discovered: 0, indexed: 0 })
      database.write(writer => writer.exec('DROP TABLE search_documents_fts'))

      expect(() => index.query('long needle')).toThrow()
    } finally {
      database.close()
    }
  })

  it('filters and limits owners in SQL while returning bounded matches and counts', async () => {
    const { database, index } = await setup()
    try {
      for (let owner = 0; owner < 3; owner += 1) {
        const path = `/projects/-repo/session-${owner}.jsonl`
        index.replaceSource(source({
          path,
          ownerSessionId: `session-${owner}`,
          ownerTranscriptPath: path,
          modifiedAtMs: 100 + owner,
          mtimeMs: 100 + owner,
        }), Array.from({ length: 4 }, (_, line) => ({
          jsonlLine: line + 1,
          byteStart: line * 100,
          byteLength: 100,
          segmentIndex: 0,
          role: 'user' as const,
          messageId: null,
          timestamp: null,
          body: `shared needle owner ${owner} line ${line}`,
          normalizedBody: `shared needle owner ${owner} line ${line}`,
        })))
      }
      index.setReadiness({ state: 'ready', discovered: 3, indexed: 3 })

      expect(index.countSources()).toBe(3)
      expect(index.listSources().map(source => source.ownerSessionId)).toEqual([
        'session-0',
        'session-1',
        'session-2',
      ])

      const result = index.query('needle', {
        project: '-repo',
        modifiedAfterMs: 100,
        modifiedBeforeMs: 102,
        limit: 2,
        matchesPerSession: 2,
      })
      expect(result).not.toBeNull()
      expect(result?.truncated).toBe(true)
      expect(result?.sessions.map(session => session.ownerSessionId)).toEqual([
        'session-2',
        'session-1',
      ])
      expect(result?.sessions[0]).toMatchObject({ matchCount: 4 })
      expect(result?.sessions[0]?.matches).toHaveLength(2)
    } finally {
      database.close()
    }
  })

  it('rolls back source replacement if any document violates the schema', async () => {
    const { database, index } = await setup()
    try {
      index.replaceSource(source(), [{
        jsonlLine: 1,
        byteStart: 0,
        byteLength: 10,
        segmentIndex: 0,
        role: 'user',
        messageId: null,
        timestamp: null,
        body: 'old searchable body',
        normalizedBody: 'old searchable body',
      }])
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })

      expect(() => index.replaceSource(source(), [{
        jsonlLine: 2,
        byteStart: 10,
        byteLength: 10,
        segmentIndex: 0,
        role: 'invalid' as 'user',
        messageId: null,
        timestamp: null,
        body: 'new body',
        normalizedBody: 'new body',
      }])).toThrow()
      expect(index.query('old searchable')?.sessions).toHaveLength(1)
      expect(index.query('new body')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })

  it('rejects an already-aborted batch without creating a source', async () => {
    const { database, index } = await setup()
    const controller = new AbortController()
    controller.abort()

    try {
      await expect(index.replaceSourceBatched(source(), [], {
        signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' })
      expect(index.getSource(source().path)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('normalizes a custom abort reason without mutating the original error', async () => {
    const { database, index } = await setup()
    const controller = new AbortController()
    const reason = new Error('projection cancelled')
    controller.abort(reason)

    try {
      await expect(index.replaceSourceBatched(source(), [], {
        signal: controller.signal,
      })).rejects.toMatchObject({
        name: 'AbortError',
        message: 'projection cancelled',
        cause: reason,
      })
      expect(reason.name).toBe('Error')
      expect(index.getSource(source().path)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('uses default batch limits and the passive checkpoint fallback', async () => {
    const { database } = await setup()
    let passiveCheckpoints = 0
    const fallbackDatabase = {
      ...database,
      checkpointTruncate: undefined,
      checkpointPassive: () => {
        passiveCheckpoints += 1
        return database.checkpointPassive()
      },
    } as typeof database
    const index = createSearchContentIndex(fallbackDatabase, {
      scope: source().projectPath,
    })

    try {
      expect(await index.replaceSourceBatched(source(), [{
        jsonlLine: 1,
        byteStart: 0,
        byteLength: 10,
        segmentIndex: 0,
        role: 'user',
        messageId: null,
        timestamp: null,
        body: 'default batch fallback',
        normalizedBody: 'default batch fallback',
      }])).toEqual({ kind: 'committed' })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })

      expect(passiveCheckpoints).toBeGreaterThan(1)
      expect(index.query('default batch')?.sessions).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('appends documents in byte-bounded batches and finalizes the source', async () => {
    const { database, index } = await setup()
    const firstDocument = {
      jsonlLine: 1,
      byteStart: 0,
      byteLength: 10,
      segmentIndex: 0,
      role: 'user' as const,
      messageId: null,
      timestamp: null,
      body: 'original body',
      normalizedBody: 'original body',
    }
    const appendedDocuments = [2, 3].map(jsonlLine => ({
      ...firstDocument,
      jsonlLine,
      byteStart: (jsonlLine - 1) * 10,
      body: `appended body ${jsonlLine}`,
      normalizedBody: `appended body ${jsonlLine}`,
    }))
    let committedBatches = 0

    try {
      index.replaceSource(source({ indexedLines: 1 }), [firstDocument])
      expect(await index.appendSourceBatched(
        source({ indexedLines: 3 }),
        appendedDocuments,
        {
          batchDocumentLimit: 10,
          batchByteLimit: 1,
          onBatchCommitted: () => {
            committedBatches += 1
            return true
          },
        },
      )).toEqual({ kind: 'committed' })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })

      expect(committedBatches).toBe(4)
      expect(index.getSource(source().path)).toMatchObject({
        state: 'ready',
        indexedLines: 3,
      })
      expect(index.query('appended body')?.sessions[0]?.matchCount).toBe(2)
    } finally {
      database.close()
    }
  })

  it('stops replace, append, and delete at each storage-limit boundary', async () => {
    const { database, index } = await setup()
    const document = {
      jsonlLine: 1,
      byteStart: 0,
      byteLength: 10,
      segmentIndex: 0,
      role: 'user' as const,
      messageId: null,
      timestamp: null,
      body: 'storage boundary body',
      normalizedBody: 'storage boundary body',
    }
    const appendedDocument = {
      ...document,
      jsonlLine: 2,
      byteStart: 10,
    }
    const stopAfter = (target: number) => {
      let commits = 0
      return () => {
        commits += 1
        return commits < target
      }
    }

    try {
      expect(await index.replaceSourceBatched(source(), [document], {
        onBatchCommitted: () => false,
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })
      expect(await index.replaceSourceBatched(source(), [document], {
        onBatchCommitted: stopAfter(2),
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })
      expect(await index.replaceSourceBatched(source(), [document], {
        onBatchCommitted: stopAfter(3),
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })
      expect(await index.replaceSourceBatched(source(), [document])).toEqual({
        kind: 'committed',
      })

      expect(await index.appendSourceBatched(source(), [appendedDocument], {
        onBatchCommitted: () => false,
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })
      expect(await index.appendSourceBatched(source(), [appendedDocument], {
        onBatchCommitted: stopAfter(2),
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })

      expect(await index.deleteSourceBatched(source().path, {
        onBatchCommitted: () => false,
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })
      expect(await index.deleteSourceBatched(source().path, {
        onBatchCommitted: stopAfter(2),
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })
    } finally {
      database.close()
    }
  })

  it('rejects a batched append before creating missing source metadata', async () => {
    const { database, index } = await setup()

    try {
      await expect(index.appendSourceBatched(source(), [])).rejects.toThrow(
        'Cannot append an unindexed search source',
      )
      expect(index.getSource(source().path)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('treats a batched delete of a missing source as committed', async () => {
    const { database, index } = await setup()
    let callbacks = 0

    try {
      expect(await index.deleteSourceBatched('/missing.jsonl', {
        onBatchCommitted: () => {
          callbacks += 1
          return true
        },
      })).toEqual({ kind: 'committed' })
      expect(callbacks).toBe(0)
    } finally {
      database.close()
    }
  })

  it('keeps an interrupted batched delete hidden and completes it on retry', async () => {
    const { database, index } = await setup()
    const documents = [1, 2].map(jsonlLine => ({
      jsonlLine,
      byteStart: (jsonlLine - 1) * 10,
      byteLength: 10,
      segmentIndex: 0,
      role: 'user' as const,
      messageId: null,
      timestamp: null,
      body: `delete recovery ${jsonlLine}`,
      normalizedBody: `delete recovery ${jsonlLine}`,
    }))

    try {
      index.replaceSource(source(), documents)
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(await index.deleteSourceBatched(source().path, {
        batchDocumentLimit: 1,
        onBatchCommitted: () => false,
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })
      expect(index.getSource(source().path)?.state).toBe('pending')
      expect(index.query('delete recovery')?.sessions).toEqual([])

      expect(await index.deleteSourceBatched(source().path, {
        batchDocumentLimit: 1,
      })).toEqual({ kind: 'committed' })
      expect(index.getSource(source().path)).toBeNull()
    } finally {
      database.close()
    }
  })

  it('keeps batched replace and delete commits hidden until finalized', async () => {
    const { database, index } = await setup()
    let checkpoints = 0
    ;(database as typeof database & {
      checkpointTruncate: () => { busy: number; logFrames: number; checkpointedFrames: number }
    }).checkpointTruncate = () => {
      checkpoints += 1
      return { busy: 0, logFrames: 0, checkpointedFrames: 0 }
    }

    const documents = Array.from({ length: 3 }, (_, offset) => ({
      jsonlLine: offset + 1,
      byteStart: offset * 10,
      byteLength: 10,
      segmentIndex: 0,
      role: 'user' as const,
      messageId: null,
      timestamp: null,
      body: `batched needle ${offset}`,
      normalizedBody: `batched needle ${offset}`,
    }))
    const statesAfterReplaceBatches: Array<string | null> = []
    let replaceYields = 0

    try {
      expect(await index.replaceSourceBatched(source(), documents, {
        batchDocumentLimit: 1,
        onBatchCommitted: () => {
          statesAfterReplaceBatches.push(index.getSource(source().path)?.state ?? null)
          return true
        },
        yieldToForeground: async () => {
          replaceYields += 1
        },
      })).toEqual({ kind: 'committed' })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })

      expect(statesAfterReplaceBatches.length).toBeGreaterThan(1)
      expect(statesAfterReplaceBatches.at(-1)).toBe('ready')
      expect(statesAfterReplaceBatches.slice(0, -1).every(state => state === 'pending')).toBe(true)
      expect(replaceYields).toBe(statesAfterReplaceBatches.length)
      expect(checkpoints).toBe(statesAfterReplaceBatches.length)
      expect(index.query('batched needle')?.sessions[0]?.matchCount).toBe(3)

      const visibleDuringDelete: number[] = []
      let deleteYields = 0
      expect(await index.deleteSourceBatched(source().path, {
        batchDocumentLimit: 1,
        onBatchCommitted: () => {
          visibleDuringDelete.push(index.query('batched needle')?.sessions.length ?? 0)
          return true
        },
        yieldToForeground: async () => {
          deleteYields += 1
        },
      })).toEqual({ kind: 'committed' })

      expect(visibleDuringDelete.length).toBeGreaterThan(1)
      expect(visibleDuringDelete.every(count => count === 0)).toBe(true)
      expect(deleteYields).toBe(visibleDuringDelete.length)
      expect(index.getSource(source().path)).toBeNull()
      expect(index.query('batched needle')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })
})
