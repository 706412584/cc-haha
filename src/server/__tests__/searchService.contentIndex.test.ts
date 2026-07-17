import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SearchService } from '../services/searchService.js'
import type { SearchContentQueryResult } from '../services/localIndex/searchContentIndex.js'
import {
  captureSourceFingerprint,
  serializeSourceFingerprint,
} from '../services/localIndex/sourceFingerprint.js'
import { sessionService } from '../services/sessionService.js'

let scope: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  scope = await mkdtemp(join(tmpdir(), 'cc-haha-search-service-content-index-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = scope
  await mkdir(join(scope, 'projects', '-repo'), { recursive: true })
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(scope, { recursive: true, force: true })
})

function indexedResult(overrides: Partial<SearchContentQueryResult> = {}): SearchContentQueryResult {
  const ownerTranscriptPath = join(scope, 'projects', '-repo', 'owner-session.jsonl')
  return {
    sessions: [{
      ownerSessionId: 'owner-session',
      ownerTranscriptPath,
      projectPath: '-repo',
      modifiedAtMs: Date.parse('2026-07-16T00:00:00.000Z'),
      matchCount: 1,
      matches: [{
        sourcePath: ownerTranscriptPath,
        ownerSessionId: 'owner-session',
        ownerTranscriptPath,
        projectPath: '-repo',
        modifiedAtMs: Date.parse('2026-07-16T00:00:00.000Z'),
        byteStart: 0,
        byteLength: 1,
        sourceSizeBytes: 0,
        sourceMtimeMs: 0,
        sourceFileIdentity: null,
        sourceFingerprint: '',
        sourceIndexedBytes: 0,
        sourceParserVersion: 1,
        lineNumber: 1,
        segmentIndex: 0,
        role: 'user',
        messageId: 'message-1',
        timestamp: '2026-07-16T00:00:00.000Z',
        body: 'SQLite indexed content needle',
      }],
    }],
    truncated: false,
    ...overrides,
  }
}

async function verificationFields(
  sourcePath: string,
  byteStart = 0,
  byteLength?: number,
): Promise<{
  byteStart: number
  byteLength: number
  sourceSizeBytes: number
  sourceMtimeMs: number
  sourceFileIdentity: string | null
  sourceFingerprint: string
  sourceIndexedBytes: number
  sourceParserVersion: number
}> {
  const snapshot = await stat(sourcePath)
  const fingerprint = await captureSourceFingerprint({
    path: sourcePath,
    indexedBytes: snapshot.size,
    parserVersion: 1,
  })
  return {
    byteStart,
    byteLength: byteLength ?? snapshot.size,
    sourceSizeBytes: fingerprint.size,
    sourceMtimeMs: fingerprint.mtimeMs,
    sourceFileIdentity: fingerprint.fileIdentity,
    sourceFingerprint: serializeSourceFingerprint(fingerprint),
    sourceIndexedBytes: fingerprint.indexedBytes,
    sourceParserVersion: fingerprint.parserVersion,
  }
}

function attachVerification(
  result: SearchContentQueryResult,
  fields: Awaited<ReturnType<typeof verificationFields>>,
): SearchContentQueryResult {
  Object.assign(result.sessions[0]?.matches[0] ?? {}, fields)
  return result
}

describe('SearchService SQLite content path', () => {
  test('uses a ready content projection without invoking rg', async () => {
    const ownerPath = join(scope, 'projects', '-repo', 'owner-session.jsonl')
    const canonicalLine = `${JSON.stringify({
      type: 'user',
      uuid: 'message-1',
      timestamp: '2026-07-16T00:00:00.000Z',
      message: { role: 'user', content: 'SQLite indexed content needle' },
    })}\n`
    await writeFile(ownerPath, canonicalLine)
    const indexed = attachVerification(
      indexedResult(),
      await verificationFields(ownerPath, 0, Buffer.byteLength(canonicalLine)),
    )
    let observedOptions: Record<string, unknown> | undefined
    const service = new SearchService({
      searchIndexedContent: (_query, options) => {
        observedOptions = options
        return indexed
      },
      getMetadataForPaths: async paths => {
        expect(paths).toEqual([ownerPath])
        return new Map([[resolve(ownerPath), {
          title: 'Indexed owner title',
          modifiedAt: '2026-07-16T00:00:00.000Z',
          workDir: '/repo',
          projectPath: '-repo',
        }]])
      },
    } as never)
    ;(service as unknown as { commandExists: () => never }).commandExists = () => {
      throw new Error('rg must not run for a ready content index')
    }

    const result = await service.searchSessions('needle', {
      project: '-repo',
      modifiedAfter: '2026-01-01T00:00:00.000Z',
      matchesPerSession: 3,
    })

    expect(observedOptions).toMatchObject({
      project: '-repo',
      modifiedAfterMs: Date.parse('2026-01-01T00:00:00.000Z'),
      limit: 60,
      matchesPerSession: 3,
      caseSensitive: false,
    })
    expect(result).toEqual({
      results: [{
        sessionId: 'owner-session',
        title: 'Indexed owner title',
        projectPath: '-repo',
        workDir: '/repo',
        modifiedAt: '2026-07-16T00:00:00.000Z',
        matchCount: 1,
        matches: [{
          role: 'user',
          messageId: 'message-1',
          lineNumber: 1,
          snippet: 'SQLite indexed content needle',
          highlights: [{ start: 23, end: 29 }],
          timestamp: '2026-07-16T00:00:00.000Z',
        }],
      }],
      truncated: false,
    })
  })

  test('falls back to canonical JSONL when the content projection is not ready', async () => {
    const ownerPath = join(scope, 'projects', '-repo', 'fallback-session.jsonl')
    await writeFile(ownerPath, `${JSON.stringify({
      type: 'user',
      uuid: 'fallback-message',
      message: { role: 'user', content: 'canonical fallback needle' },
    })}\n`)
    const service = new SearchService({ searchIndexedContent: () => null } as never)
    ;(service as unknown as { commandExists: () => Promise<boolean> }).commandExists = async () => false

    const result = await service.searchSessions('fallback needle')

    expect(result.results.map(item => item.sessionId)).toEqual(['fallback-session'])
    expect(result.results[0]?.matches[0]?.snippet).toBe('canonical fallback needle')
  })

  test('maps a nested subagent hit to its openable owner session', async () => {
    const ownerPath = join(scope, 'projects', '-repo', 'lead-session.jsonl')
    const nestedPath = join(
      scope,
      'projects',
      '-repo',
      'lead-session',
      'subagents',
      'agent-worker.jsonl',
    )
    await mkdir(join(nestedPath, '..'), { recursive: true })
    await writeFile(ownerPath, '{}\n')
    const nestedLine = `${JSON.stringify({
      type: 'assistant',
      uuid: 'agent-message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'nested ownership needle' }] },
    })}\n`
    await writeFile(nestedPath, nestedLine)
    const nested = indexedResult({
      sessions: [{
        ownerSessionId: 'lead-session',
        ownerTranscriptPath: ownerPath,
        projectPath: '-repo',
        modifiedAtMs: 100,
        matchCount: 1,
        matches: [{
          sourcePath: nestedPath,
          ownerSessionId: 'lead-session',
          ownerTranscriptPath: ownerPath,
          projectPath: '-repo',
          modifiedAtMs: 100,
          byteStart: 0,
          byteLength: Buffer.byteLength(nestedLine),
          sourceSizeBytes: Buffer.byteLength(nestedLine),
          sourceMtimeMs: 0,
          sourceFileIdentity: null,
          sourceFingerprint: '',
          sourceIndexedBytes: Buffer.byteLength(nestedLine),
          sourceParserVersion: 1,
          lineNumber: 1,
          segmentIndex: 0,
          role: 'assistant',
          messageId: 'agent-message',
          timestamp: null,
          body: 'nested ownership needle',
        }],
      }],
    })
    attachVerification(
      nested,
      await verificationFields(nestedPath, 0, Buffer.byteLength(nestedLine)),
    )
    const service = new SearchService({
      searchIndexedContent: () => nested,
      getMetadataForPaths: async () => new Map([[resolve(ownerPath), {
        title: 'Lead session',
        modifiedAt: '2026-07-16T00:00:00.000Z',
        workDir: '/repo',
        projectPath: '-repo',
      }]]),
    } as never)

    const result = await service.searchSessions('ownership')

    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      sessionId: 'lead-session',
      title: 'Lead session',
      matchCount: 1,
    })
    expect(result.results[0]?.matches[0]).toMatchObject({
      role: 'assistant',
      messageId: 'agent-message',
      lineNumber: 1,
    })
  })

  test('falls back to canonical files after a rewrite missed by the watcher', async () => {
    const ownerPath = join(scope, 'projects', '-repo', 'owner-session.jsonl')
    const indexedLine = `${JSON.stringify({
      type: 'user',
      uuid: 'message-1',
      message: { role: 'user', content: 'SQLite indexed content needle' },
    })}\n`
    await writeFile(ownerPath, indexedLine)
    const stale = attachVerification(
      indexedResult(),
      await verificationFields(ownerPath, 0, Buffer.byteLength(indexedLine)),
    )
    await writeFile(ownerPath, `${JSON.stringify({
      type: 'user',
      uuid: 'message-new',
      message: { role: 'user', content: 'rewritten canonical content' },
    })}\n`)
    const service = new SearchService({
      searchIndexedContent: () => stale,
      getMetadataForPaths: async () => null,
    } as never)
    ;(service as unknown as { commandExists: () => Promise<boolean> }).commandExists =
      async () => false

    const result = await service.searchSessions('needle')

    expect(result.results).toEqual([])
  })

  test('falls back when the indexed body disagrees with the canonical segment', async () => {
    const ownerPath = join(scope, 'projects', '-repo', 'owner-session.jsonl')
    const canonicalLine = `${JSON.stringify({
      type: 'user',
      uuid: 'message-1',
      timestamp: '2026-07-16T00:00:00.000Z',
      message: { role: 'user', content: 'canonical needle content' },
    })}\n`
    await writeFile(ownerPath, canonicalLine)
    const inconsistent = attachVerification(
      indexedResult(),
      await verificationFields(ownerPath, 0, Buffer.byteLength(canonicalLine)),
    )
    inconsistent.sessions[0]!.matches[0]!.body = 'stale needle content'
    const service = new SearchService({
      searchIndexedContent: () => inconsistent,
      getMetadataForPaths: async () => null,
    } as never)
    ;(service as unknown as { commandExists: () => Promise<boolean> }).commandExists =
      async () => false

    const result = await service.searchSessions('needle')

    expect(result.results[0]?.matches[0]?.snippet).toBe('canonical needle content')
  })

  test('falls back to canonical files after a delete missed by the watcher', async () => {
    const ownerPath = join(scope, 'projects', '-repo', 'owner-session.jsonl')
    const indexedLine = `${JSON.stringify({
      type: 'user',
      uuid: 'message-1',
      message: { role: 'user', content: 'SQLite indexed content needle' },
    })}\n`
    await writeFile(ownerPath, indexedLine)
    const stale = attachVerification(
      indexedResult(),
      await verificationFields(ownerPath, 0, Buffer.byteLength(indexedLine)),
    )
    await rm(ownerPath)
    const service = new SearchService({
      searchIndexedContent: () => stale,
      getMetadataForPaths: async () => null,
    } as never)
    ;(service as unknown as { commandExists: () => Promise<boolean> }).commandExists =
      async () => false

    const result = await service.searchSessions('needle')

    expect(result.results).toEqual([])
  })

  test('does not scan a large owner transcript when scalar metadata is unavailable', async () => {
    const ownerPath = join(scope, 'projects', '-repo', 'owner-session.jsonl')
    const canonicalLine = `${JSON.stringify({
      type: 'user',
      uuid: 'message-1',
      timestamp: '2026-07-16T00:00:00.000Z',
      message: { role: 'user', content: 'SQLite indexed content needle' },
    })}\n`
    await writeFile(ownerPath, `${canonicalLine}${'x'.repeat(8 * 1024 * 1024)}\n`)
    const indexed = attachVerification(
      indexedResult(),
      await verificationFields(ownerPath, 0, Buffer.byteLength(canonicalLine)),
    )
    let canonicalMetadataCalls = 0
    const originalGetMeta = sessionService.getSessionTitleAndMeta
    sessionService.getSessionTitleAndMeta = async (...args) => {
      canonicalMetadataCalls += 1
      return originalGetMeta.apply(sessionService, args)
    }
    const metrics = { candidateFiles: 0, filesOpened: 0, bytesRead: 0, fallbackFiles: 0 }
    try {
      const service = new SearchService({
        searchIndexedContent: () => indexed,
        getMetadataForPaths: async () => null,
      } as never)

      const result = await service.searchSessions('needle', { metrics })

      expect(result.results[0]).toMatchObject({
        sessionId: 'owner-session',
        title: 'owner-session',
        projectPath: '-repo',
        workDir: null,
      })
      expect(canonicalMetadataCalls).toBe(0)
      expect(metrics.bytesRead).toBeGreaterThan(0)
      expect(metrics.bytesRead).toBeLessThan((await stat(ownerPath)).size / 10)
    } finally {
      sessionService.getSessionTitleAndMeta = originalGetMeta
    }
  })
})
