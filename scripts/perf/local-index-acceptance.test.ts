import { expect, it, mock } from 'bun:test'

type DeterministicAcceptanceReport = {
  schemaVersion: number
  fixture: {
    sessions: number
    pageSize: number
    corpusFingerprint: string
  }
  sourceIntegrity: {
    unchangedAfterBackfill: boolean
    changedSourceCountAfterAppend: number
    unrelatedSourcesUnchangedAfterAppend: boolean
  }
  scheduling: {
    maxBatchSize: number
    yieldCount: number
  }
  queries: {
    page1: { offset: number; rowCount: number; statementCount: number }
    page100: { offset: number; rowCount: number; statementCount: number }
    globalPlan: string[]
    projectPlan: string[]
  }
  indexedSessionList: {
    total: number
    rowCount: number
    transcriptBodyOpens: number
  }
  componentAppend: {
    action: string
    changedSourceRows: string[]
    changedSessionRows: string[]
    messageCountDelta: number
  }
  shadow: {
    comparisonCount: number
    mismatchCount: number
    differenceCount: number
    transcriptBodyOpens: number
  }
  productAppend: {
    measured: boolean
    reason: string
  }
}

it('proves the deterministic 10k Slice 1 acceptance invariants', async () => {
  const actualFs = await import('node:fs')
  const actualFsPromises = await import('node:fs/promises')
  const originalCreateReadStream = actualFs.createReadStream
  const originalReadFile = actualFsPromises.readFile
  let transcriptBodyOpenCount = 0
  const isTranscriptBody = (path: unknown): boolean => {
    const normalized = String(path).replaceAll('\\', '/')
    return normalized.includes('/projects/') && normalized.endsWith('.jsonl')
  }
  mock.module('node:fs', () => ({
    ...actualFs,
    createReadStream(
      ...args: Parameters<typeof originalCreateReadStream>
    ): ReturnType<typeof originalCreateReadStream> {
      const path = String(args[0])
      if (isTranscriptBody(path)) transcriptBodyOpenCount += 1
      return originalCreateReadStream(...args)
    },
  }))
  mock.module('node:fs/promises', () => ({
    ...actualFsPromises,
    readFile: ((...args: Parameters<typeof originalReadFile>) => {
      if (isTranscriptBody(args[0])) transcriptBodyOpenCount += 1
      return originalReadFile(...args)
    }) as typeof originalReadFile,
  }))

  try {
    const benchmark = await import('./local-index-benchmark.js') as {
      runDeterministicAcceptance?: (options: {
        sessions: number
        entriesPerSession: number
        seed: number
        readTranscriptBodyOpenCount: () => number
      }) => Promise<DeterministicAcceptanceReport>
    }

    expect(typeof benchmark.runDeterministicAcceptance).toBe('function')
    const report = await benchmark.runDeterministicAcceptance!({
      sessions: 10_000,
      entriesPerSession: 8,
      seed: 20260714,
      readTranscriptBodyOpenCount: () => transcriptBodyOpenCount,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      fixture: {
        sessions: 10_000,
        pageSize: 100,
      },
      sourceIntegrity: {
        unchangedAfterBackfill: true,
        changedSourceCountAfterAppend: 1,
        unrelatedSourcesUnchangedAfterAppend: true,
      },
      scheduling: {
        maxBatchSize: 25,
        yieldCount: 400,
      },
      queries: {
        page1: { offset: 0, rowCount: 100, statementCount: 2 },
        page100: { offset: 9_900, rowCount: 100, statementCount: 2 },
      },
      indexedSessionList: {
        total: 10_000,
        rowCount: 400,
        transcriptBodyOpens: 0,
      },
      componentAppend: {
        action: 'append',
        messageCountDelta: 1,
      },
      shadow: {
        comparisonCount: 1,
        mismatchCount: 0,
        differenceCount: 0,
      },
    productAppend: {
      measured: false,
      reason: 'LOCAL_INDEX_RECONCILIATION_NOT_ACCEPTED',
      },
    })
    expect(report.fixture.corpusFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(report.queries.globalPlan).toEqual(expect.arrayContaining([
      expect.stringContaining('sessions_modified_idx'),
    ]))
    expect(report.queries.projectPlan).toEqual(expect.arrayContaining([
      expect.stringContaining('sessions_project_modified_idx'),
    ]))
    expect(report.queries.globalPlan).not.toContain('SCAN sessions')
    expect(report.queries.projectPlan).not.toContain('SCAN sessions')
    expect(report.componentAppend.changedSourceRows).toHaveLength(1)
    expect(report.componentAppend.changedSessionRows).toHaveLength(1)
    expect(typeof report.shadow.transcriptBodyOpens).toBe('number')
    expect(report.shadow.transcriptBodyOpens).toBeGreaterThan(0)
  } finally {
    mock.restore()
  }
}, 120_000)
