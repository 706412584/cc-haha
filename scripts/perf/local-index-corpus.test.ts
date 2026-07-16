import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import type { LocalIndexCorpusOptions } from './local-index-corpus.js'

type CorpusManifest = {
  corpusVersion: number
  seed: number
  options: {
    sessions: number
    entriesPerSession: number
    largeTranscriptBytes: number
    seed: number
  }
  features: {
    duplicateSessionIds: string[]
    malformedCompleteLines: number
    incompleteFinalLines: number
    metadataOnlyAppends: number
    subagentTranscripts: number
    taskNotifications: number
    checkpoints: number
    windowsDriveMetadata: number
    uncMetadata: number
  }
  expected: {
    normalizedSessionOrder: string[]
    totals: {
      mainTranscriptFiles: number
      sourceFiles: number
      visibleMessages: number
    }
    summaries: Array<{
      sourcePath: string
      sessionId: string
      title: string
      createdAt: string
      modifiedAt: string
      messageCount: number
    }>
    activityTotals: {
      sessions: number
      messages: number
      toolCalls: number
      tokens: number
    }
  }
  largeTranscript: {
    sourcePath: string
    requestedBytes: number
    actualBytes: number
  } | null
  sources: Array<{
    path: string
    bytes: number
    sha256: string
  }>
}

const tempDirs: string[] = []
let originalHome: string | undefined
let originalConfigDir: string | undefined
let originalLocalAccessToken: string | undefined

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `cc-haha-${label}-`))
  tempDirs.push(root)
  return root
}

async function createLocalIndexCorpus(options: LocalIndexCorpusOptions) {
  const corpusModule = await import('./local-index-corpus.js')
  return corpusModule.createLocalIndexCorpus(options)
}

function restoreEnvironment(
  name: 'HOME' | 'CLAUDE_CONFIG_DIR' | 'CC_HAHA_LOCAL_ACCESS_TOKEN',
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

beforeEach(async () => {
  originalHome = process.env.HOME
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalLocalAccessToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  const environmentRoot = await tempRoot('local-index-test-environment')
  process.env.HOME = join(environmentRoot, 'home')
  process.env.CLAUDE_CONFIG_DIR = join(environmentRoot, 'home', '.claude')
})

afterEach(async () => {
  restoreEnvironment('HOME', originalHome)
  restoreEnvironment('CLAUDE_CONFIG_DIR', originalConfigDir)
  restoreEnvironment('CC_HAHA_LOCAL_ACCESS_TOKEN', originalLocalAccessToken)
  await Promise.all(tempDirs.splice(0).map(
    dir => rm(dir, { recursive: true, force: true }),
  ))
})

async function loadManifest(manifestPath: string): Promise<CorpusManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as CorpusManifest
}

describe('createLocalIndexCorpus', () => {
  it('creates byte-identical seeded manifests and source hashes', async () => {
    const rootA = await tempRoot('local-index-a')
    const rootB = await tempRoot('local-index-b')
    const options = {
      sessions: 12,
      entriesPerSession: 8,
      largeTranscriptBytes: 32 * 1024,
      seed: 41,
    }

    const corpusA = await createLocalIndexCorpus({ rootDir: rootA, ...options })
    const corpusB = await createLocalIndexCorpus({ rootDir: rootB, ...options })

    expect(corpusA.configDir).toBe(join(rootA, 'home', '.claude'))
    expect(corpusA.projectsDir).toBe(join(corpusA.configDir, 'projects'))
    expect(corpusA.transcriptPaths).toHaveLength(options.sessions)
    expect(
      corpusA.transcriptPaths.every(file => relative(corpusA.projectsDir, file).startsWith('..') === false),
    ).toBe(true)
    expect(await readFile(corpusA.manifestPath)).toEqual(
      await readFile(corpusB.manifestPath),
    )

    const manifestA = await loadManifest(corpusA.manifestPath)
    const manifestB = await loadManifest(corpusB.manifestPath)
    expect(manifestA.sources).toEqual(manifestB.sources)
    expect(manifestA.seed).toBe(options.seed)
    expect(manifestA.options).toEqual(options)
    expect(manifestA.expected.totals.mainTranscriptFiles).toBe(options.sessions)
    expect(manifestA.expected.summaries).toHaveLength(options.sessions)
    expect(manifestA.expected.normalizedSessionOrder).toHaveLength(options.sessions)
    expect(manifestA.expected.activityTotals).toEqual({
      sessions: 12,
      messages: 36,
      toolCalls: 4,
      tokens: 354,
    })
    expect(manifestA.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true)
    expect(JSON.stringify(manifestA)).not.toContain(rootA)
    expect(JSON.stringify(manifestA)).not.toContain(rootB)
  })

  it('covers privacy-safe compatibility and append fixtures across projects', async () => {
    const root = await tempRoot('local-index-features')
    const corpus = await createLocalIndexCorpus({
      rootDir: root,
      sessions: 12,
      entriesPerSession: 8,
      largeTranscriptBytes: 24 * 1024,
      seed: 20260714,
    })
    const manifest = await loadManifest(corpus.manifestPath)
    const projectDirs = await readdir(corpus.projectsDir)
    const sessionIds = corpus.transcriptPaths.map(file => basename(file, '.jsonl'))
    const sourceText = (
      await Promise.all(manifest.sources.map(source => readFile(join(corpus.configDir, source.path), 'utf8')))
    ).join('\n')

    expect(projectDirs.length).toBeGreaterThanOrEqual(4)
    expect(new Set(sessionIds).size).toBeLessThan(sessionIds.length)
    expect(manifest.features.duplicateSessionIds.length).toBeGreaterThan(0)
    expect(manifest.features).toMatchObject({
      malformedCompleteLines: 1,
      incompleteFinalLines: 1,
      metadataOnlyAppends: 2,
      subagentTranscripts: 2,
      taskNotifications: 2,
      checkpoints: 2,
      windowsDriveMetadata: 1,
      uncMetadata: 1,
    })
    expect(sourceText).toContain('"content":"Synthetic old-shape prompt')
    expect(sourceText).toContain('"content":[{"type":"text","text":"Synthetic current-shape prompt')
    expect(sourceText).toContain('synthetic-malformed-complete-line')
    expect(sourceText).toContain('synthetic-incomplete-final-line')
    expect(sourceText).toContain('"type":"session-meta"')
    expect(sourceText).toContain('"type":"tool_use"')
    expect(sourceText).toContain('"isSidechain":true')
    expect(sourceText).toContain('<task-notification>')
    expect(sourceText).toContain('"type":"file-history-snapshot"')
    expect(sourceText).toContain('C:\\\\Synthetic\\\\Corpus')
    expect(sourceText).toContain('\\\\\\\\synthetic-server\\\\share\\\\corpus')
  })

  it('streams a configurable large transcript to at least the requested size', async () => {
    const root = await tempRoot('local-index-large')
    const requestedBytes = 96 * 1024
    const corpus = await createLocalIndexCorpus({
      rootDir: root,
      sessions: 8,
      entriesPerSession: 8,
      largeTranscriptBytes: requestedBytes,
      seed: 7,
    })
    const manifest = await loadManifest(corpus.manifestPath)

    expect(manifest.largeTranscript).not.toBeNull()
    const largeSource = manifest.largeTranscript!
    const largePath = join(corpus.configDir, largeSource.sourcePath)
    const largeStat = await stat(largePath)
    expect(largeSource.requestedBytes).toBe(requestedBytes)
    expect(largeSource.actualBytes).toBe(largeStat.size)
    expect(largeStat.size).toBeGreaterThanOrEqual(requestedBytes)
    expect(await readFile(largePath, 'utf8')).toContain('synthetic-large-record')
  })

  it('retries controllable short writes until the complete buffer is persisted', async () => {
    const corpusModule = await import('./local-index-corpus.js')
    const writeBufferFully = (
      corpusModule as unknown as {
        writeBufferFully?: (
          writer: {
            write: (
              buffer: Uint8Array,
              offset: number,
              length: number,
            ) => Promise<{ bytesWritten: number }>
          },
          buffer: Uint8Array,
        ) => Promise<number>
      }
    ).writeBufferFully
    expect(typeof writeBufferFully).toBe('function')

    const chunks: Buffer[] = []
    const requestedLengths: number[] = []
    const writer = {
      async write(buffer: Uint8Array, offset: number, length: number) {
        requestedLengths.push(length)
        const bytesWritten = Math.min(3, length)
        chunks.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)))
        return { bytesWritten }
      },
    }
    const payload = Buffer.from('short-write-proof')

    const bytesWritten = await writeBufferFully!(writer, payload)

    expect(bytesWritten).toBe(payload.length)
    expect(Buffer.concat(chunks)).toEqual(payload)
    expect(requestedLengths).toEqual([17, 14, 11, 8, 5, 2])
  })
})

async function runBenchmarkProcess(args: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const processHandle = Bun.spawn({
    cmd: [
      process.execPath,
      'run',
      join(import.meta.dir, 'local-index-benchmark.ts'),
      ...args,
    ],
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe('local index file benchmark', () => {
  it('enforces real warmup and measured sample deadlines with cleanup', async () => {
    const benchmark = await import('./local-index-benchmark.js') as {
      parseBenchmarkArgs?: (args: string[]) => unknown
      runBenchmark?: (
        options: unknown,
        dependencies?: {
          executeSessionList?: (
            execute: () => Promise<unknown>,
            context: {
              phase: 'warmup' | 'measured'
              index: number
              rootDir: string
            },
          ) => Promise<unknown>
        },
      ) => Promise<unknown>
    }
    expect(typeof benchmark.parseBenchmarkArgs).toBe('function')
    expect(typeof benchmark.runBenchmark).toBe('function')

    const originalEnvironment = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CC_HAHA_LOCAL_INDEX: process.env.CC_HAHA_LOCAL_INDEX,
    }
    for (const expectedPhase of ['warmup', 'measured'] as const) {
      const contexts: Array<{
        phase: 'warmup' | 'measured'
        index: number
        rootDir: string
      }> = []
      const options = benchmark.parseBenchmarkArgs!([
        '--sessions',
        '8',
        '--entries-per-session',
        '8',
        '--runs',
        '3',
        '--warmup-runs',
        expectedPhase === 'warmup' ? '2' : '0',
        '--timeout-ms',
        '5',
        '--seed',
        expectedPhase === 'warmup' ? '79' : '80',
        '--mode',
        'file',
      ])
      const startedAt = performance.now()
      let caught: unknown
      try {
        await Promise.race([
          benchmark.runBenchmark!(options, {
            executeSessionList: async (_execute, context) => {
              contexts.push(context)
              return new Promise<never>(() => {})
            },
          }),
          Bun.sleep(500).then(() => {
            throw new Error('benchmark invocation did not exit after sample deadline')
          }),
        ])
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain(
        `${expectedPhase} sample 1 exceeded 5ms`,
      )
      expect((caught as Error).message).toContain('timeoutCount=1')
      expect(caught).toMatchObject({
        name: 'BenchmarkSampleTimeoutError',
        phase: expectedPhase,
        index: 0,
        timeoutMs: 5,
        timeoutCount: 1,
      })
      expect(performance.now() - startedAt).toBeLessThan(500)
      expect(contexts).toHaveLength(1)
      expect(contexts[0]).toMatchObject({ phase: expectedPhase, index: 0 })
      expect(await stat(contexts[0]!.rootDir).then(() => true, () => false)).toBe(false)
      expect(process.env.HOME).toBe(originalEnvironment.HOME)
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalEnvironment.CLAUDE_CONFIG_DIR)
      expect(process.env.CC_HAHA_LOCAL_INDEX).toBe(originalEnvironment.CC_HAHA_LOCAL_INDEX)
    }
  })

  it('clears completed deadline timers and consumes a rejection after timeout', async () => {
    const benchmark = await import('./local-index-benchmark.js') as {
      runWithSampleDeadline?: <T>(options: {
        execute: () => Promise<T>
        timeoutMs: number
        phase: 'warmup' | 'measured'
        index: number
        setTimer?: typeof setTimeout
        clearTimer?: typeof clearTimeout
      }) => Promise<T>
    }
    expect(typeof benchmark.runWithSampleDeadline).toBe('function')

    let clearCount = 0
    const completed = await benchmark.runWithSampleDeadline!({
      execute: async () => 'complete',
      timeoutMs: 100,
      phase: 'measured',
      index: 0,
      clearTimer: timer => {
        clearCount += 1
        clearTimeout(timer)
      },
    })
    expect(completed).toBe('complete')
    expect(clearCount).toBe(1)

    let rejectLate!: (error: Error) => void
    const late = new Promise<never>((_resolve, reject) => {
      rejectLate = reject
    })
    await expect(benchmark.runWithSampleDeadline!({
      execute: () => late,
      timeoutMs: 5,
      phase: 'warmup',
      index: 0,
    })).rejects.toThrow('warmup sample 1 exceeded 5ms')
    rejectLate(new Error('late sample rejection'))
    await Bun.sleep(0)

    let resolveLate!: (value: string) => void
    const lateResolution = new Promise<string>(resolve => {
      resolveLate = resolve
    })
    await expect(benchmark.runWithSampleDeadline!({
      execute: () => lateResolution,
      timeoutMs: 5,
      phase: 'measured',
      index: 0,
    })).rejects.toThrow('measured sample 1 exceeded 5ms')
    resolveLate('late sample resolution')
    await Bun.sleep(0)
  })

  it('captures first useful content when its request settles without waiting for ready', async () => {
    const benchmark = await import('./local-index-benchmark.js') as {
      captureStartupResponses?: <TFirst, TReady>(options: {
        firstUsefulRequest: Promise<TFirst>
        readyRequest: Promise<TReady>
        elapsedSinceServerStartMs: () => number
        onFirstUsefulSettled?: (durationMs: number) => void
      }) => Promise<{
        firstUseful: TFirst
        ready: TReady
        firstUsefulDurationMs: number
      }>
    }
    expect(typeof benchmark.captureStartupResponses).toBe('function')

    let resolveFirstUseful!: (value: string) => void
    let resolveReady!: (value: string) => void
    let elapsedMs = 0
    let capturedBeforeReady: number | undefined
    const firstUsefulRequest = new Promise<string>(resolve => {
      resolveFirstUseful = resolve
    })
    const readyRequest = new Promise<string>(resolve => {
      resolveReady = resolve
    })
    const startup = benchmark.captureStartupResponses!({
      firstUsefulRequest,
      readyRequest,
      elapsedSinceServerStartMs: () => elapsedMs,
      onFirstUsefulSettled: durationMs => {
        capturedBeforeReady = durationMs
      },
    })

    elapsedMs = 25
    resolveFirstUseful('first')
    await Bun.sleep(0)
    expect(capturedBeforeReady).toBe(25)

    elapsedMs = 10_000
    resolveReady('ready')
    await expect(startup).resolves.toEqual({
      firstUseful: 'first',
      ready: 'ready',
      firstUsefulDurationMs: 25,
    })
  })

  it('enforces the real loopback product deadline and still cleans isolated state', async () => {
    await import('../../src/server/index.js')
    await import('../../src/server/services/localIndex/coordinator.js')
    const benchmark = await import('./local-index-benchmark.js') as {
      parseBenchmarkArgs?: (args: string[]) => unknown
      runBenchmark?: (
        options: unknown,
        dependencies?: {
          onProductGatesStart?: (context: { rootDir: string }) => void
        },
      ) => Promise<unknown>
    }
    expect(typeof benchmark.parseBenchmarkArgs).toBe('function')
    expect(typeof benchmark.runBenchmark).toBe('function')
    const originalEnvironment = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CC_HAHA_LOCAL_INDEX: process.env.CC_HAHA_LOCAL_INDEX,
      CC_HAHA_LOCAL_ACCESS_TOKEN: process.env.CC_HAHA_LOCAL_ACCESS_TOKEN,
    }
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'benchmark-parent-local-access-token'
    const options = benchmark.parseBenchmarkArgs!([
      '--sessions',
      '50',
      '--entries-per-session',
      '8',
      '--runs',
      '1',
      '--warmup-runs',
      '0',
      '--timeout-ms',
      '1',
      '--seed',
      '81',
      '--mode',
      'sqlite',
    ])
    let rootDir: string | undefined
    let caught: unknown

    try {
      await benchmark.runBenchmark!(options, {
        onProductGatesStart: context => {
          rootDir = context.rootDir
        },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      name: 'ProductGateTimeoutError',
      timeoutMs: 1,
    })
    expect((caught as Error).message).toContain('sqlite product gates exceeded 1ms')
    expect(rootDir).toBeDefined()
    expect(await stat(rootDir!).then(() => true, () => false)).toBe(false)
    expect(process.env.HOME).toBe(originalEnvironment.HOME)
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(originalEnvironment.CLAUDE_CONFIG_DIR)
    expect(process.env.CC_HAHA_LOCAL_INDEX).toBe(originalEnvironment.CC_HAHA_LOCAL_INDEX)
    expect(process.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe(
      'benchmark-parent-local-access-token',
    )
  })

  it('reports an isolated JSON baseline and removes its temporary corpus', async () => {
    const sentinelRoot = process.env.CLAUDE_CONFIG_DIR!
    const { exitCode, stdout, stderr } = await runBenchmarkProcess([
        '--sessions',
        '8',
        '--entries-per-session',
        '8',
        '--large-transcript-bytes',
        `${16 * 1024}`,
        '--runs',
        '1',
        '--warmup-runs',
        '1',
        '--seed',
        '73',
        '--mode',
        'file',
    ])

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    const report = JSON.parse(stdout) as {
      schemaVersion: number
      mode: string
      fixture: {
        rootDir: string
        configDir: string
        seed: number
        sessions: number
        corpusFingerprint: string
        kept: boolean
      }
      measurement: {
        warmupRuns: number
        runs: number
        durationMs: { median: number; p95: number; max: number }
        timeoutCount: number
        cpuMs: { user: number; system: number; total: number }
        rssDeltaBytes: number
        io: {
          instrumented: boolean
          filesOpened: number | null
          bytesRead: number | null
        }
      }
      validation: {
        expectedSessions: number
        actualSessions: number
        orderMatches: boolean
        summariesMatch: boolean
      }
    }
    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: 'file',
      fixture: {
        seed: 73,
        sessions: 8,
        kept: false,
      },
      measurement: {
        warmupRuns: 1,
        runs: 1,
        timeoutCount: 0,
        io: {
          instrumented: false,
          filesOpened: null,
          bytesRead: null,
        },
      },
      validation: {
        expectedSessions: 8,
        actualSessions: 8,
        orderMatches: true,
        summariesMatch: true,
      },
    })
    expect(report.fixture.configDir.startsWith(report.fixture.rootDir)).toBe(true)
    expect(report.fixture.configDir).not.toContain(sentinelRoot)
    expect(report.fixture.corpusFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(report.measurement.durationMs.median).toBeGreaterThanOrEqual(0)
    expect(report.measurement.durationMs.p95).toBeGreaterThanOrEqual(0)
    expect(report.measurement.durationMs.max).toBeGreaterThanOrEqual(0)
    expect(report.measurement.cpuMs.total).toBeGreaterThanOrEqual(0)
    expect(await stat(report.fixture.rootDir).then(() => true, () => false)).toBe(false)
  })

  it('keeps an inspectable corpus only when --keep is explicit', async () => {
    const result = await runBenchmarkProcess([
      '--sessions',
      '8',
      '--runs',
      '1',
      '--warmup-runs',
      '0',
      '--seed',
      '74',
      '--mode',
      'file',
      '--keep',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as {
      fixture: {
        rootDir: string
        configDir: string
        manifestPath?: string
        kept: boolean
      }
    }
    const keptRoot = report.fixture.rootDir
    try {
      expect(report.fixture.kept).toBe(true)
      expect(typeof report.fixture.manifestPath).toBe('string')
      expect(await stat(keptRoot).then(() => true, () => false)).toBe(true)
      expect(
        await stat(report.fixture.manifestPath!).then(() => true, () => false),
      ).toBe(true)
      expect(report.fixture.manifestPath?.startsWith(keptRoot)).toBe(true)
    } finally {
      await rm(keptRoot, { recursive: true, force: true })
    }
    expect(await stat(keptRoot).then(() => true, () => false)).toBe(false)
  })

  it('reports bounded incremental IO for the append scenario', async () => {
    const result = await runBenchmarkProcess([
      '--sessions',
      '8',
      '--entries-per-session',
      '8',
      '--scenario',
      'append',
      '--large-transcript-mib',
      '1',
      '--runs',
      '2',
      '--warmup-runs',
      '0',
      '--seed',
      '75',
      '--mode',
      'file',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as {
      scenario: string
      fixture: {
        largeTranscriptBytes: number
        appendBytes: number
        kept: boolean
      }
      measurement: {
        runs: number
        io: {
          instrumented: boolean
          filesOpened: number
          bytesRead: number
          maxBytesReadPerRun: number
          statCalls: number
          limitBytes: number
          withinLimit: boolean
        }
      }
      validation: {
        changeKind: string
        nextOffsetAdvancedBy: number
        pendingTailBytes: number
        snapshotVerified: boolean
      }
    }
    expect(report).toMatchObject({
      scenario: 'append',
      fixture: {
        largeTranscriptBytes: 1024 * 1024,
        appendBytes: 4096,
        kept: false,
      },
      measurement: {
        runs: 2,
        io: {
          instrumented: true,
          limitBytes: 1024 * 1024,
          withinLimit: true,
        },
      },
      validation: {
        changeKind: 'append',
        nextOffsetAdvancedBy: 4096,
        pendingTailBytes: 0,
        snapshotVerified: true,
      },
    })
    expect(report.measurement.io.filesOpened).toBeGreaterThan(0)
    expect(report.measurement.io.bytesRead).toBeGreaterThanOrEqual(
      report.measurement.io.maxBytesReadPerRun,
    )
    expect(report.measurement.io.statCalls).toBeGreaterThan(0)
    expect(report.measurement.io.maxBytesReadPerRun).toBeLessThanOrEqual(1024 * 1024)
  })

  it('runs a real shadow backfill and reports zero normalized mismatches', async () => {
    const sentinelRoot = process.env.CLAUDE_CONFIG_DIR!
    const result = await runBenchmarkProcess([
      '--sessions',
      '8',
      '--entries-per-session',
      '8',
      '--runs',
      '1',
      '--warmup-runs',
      '1',
      '--seed',
      '76',
      '--mode',
      'shadow',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as {
      schemaVersion: number
      mode: string
      scenario: string
      fixture: {
        rootDir: string
        configDir: string
        sessions: number
        kept: boolean
      }
      index: {
        readyDurationMs: number
        status: {
          mode: string
          state: string
          discovered: number
          indexed: number
          degradedSources: number
          lastErrorCode: string | null
        }
      }
      measurement: {
        warmupRuns: number
        runs: number
        durationMs: { median: number; p95: number; max: number }
      }
      validation: {
        expectedSessions: number
        actualSessions: number
        orderMatches: boolean
        summariesMatch: boolean
        comparisonCount: number
        mismatchCount: number
        differenceCount: number
      }
    }
    expect(report).toMatchObject({
      schemaVersion: 1,
      mode: 'shadow',
      scenario: 'baseline',
      fixture: {
        sessions: 8,
        kept: false,
      },
      index: {
        status: {
          mode: 'shadow',
          state: 'ready',
          discovered: 8,
          indexed: 8,
          degradedSources: 0,
          lastErrorCode: null,
        },
      },
      measurement: {
        warmupRuns: 1,
        runs: 1,
      },
      validation: {
        expectedSessions: 8,
        actualSessions: 8,
        orderMatches: true,
        summariesMatch: true,
        comparisonCount: 2,
        mismatchCount: 0,
        differenceCount: 0,
      },
    })
    expect(report.fixture.configDir.startsWith(report.fixture.rootDir)).toBe(true)
    expect(report.fixture.configDir).not.toContain(sentinelRoot)
    expect(report.index.readyDurationMs).toBeGreaterThanOrEqual(0)
    expect(report.measurement.durationMs.median).toBeGreaterThanOrEqual(0)
    expect(await stat(report.fixture.rootDir).then(() => true, () => false)).toBe(false)
    expect(JSON.stringify(report)).not.toContain(sentinelRoot)
  })

  it('keeps the shadow corpus and closed SQLite index inspectable with --keep', async () => {
    const result = await runBenchmarkProcess([
      '--sessions',
      '8',
      '--entries-per-session',
      '8',
      '--runs',
      '1',
      '--warmup-runs',
      '0',
      '--seed',
      '77',
      '--mode',
      'shadow',
      '--keep',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as {
      fixture: {
        rootDir: string
        configDir: string
        manifestPath: string
        kept: boolean
      }
      index: {
        status: { mode: string; state: string; indexed: number }
      }
      validation: {
        mismatchCount: number
      }
    }
    const rootDir = report.fixture.rootDir
    try {
      const manifest = await loadManifest(report.fixture.manifestPath)
      const firstSource = join(report.fixture.configDir, manifest.sources[0]!.path)
      const databasePath = join(
        report.fixture.configDir,
        'cc-haha',
        'db',
        'index-v1.sqlite',
      )

      expect(report).toMatchObject({
        fixture: { kept: true },
        index: {
          status: { mode: 'shadow', state: 'ready', indexed: 8 },
        },
        validation: { mismatchCount: 0 },
      })
      expect(await stat(rootDir).then(() => true, () => false)).toBe(true)
      expect(await stat(report.fixture.manifestPath).then(() => true, () => false)).toBe(true)
      expect(await stat(firstSource).then(() => true, () => false)).toBe(true)
      expect(await stat(databasePath).then(() => true, () => false)).toBe(true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
    expect(await stat(rootDir).then(() => true, () => false)).toBe(false)
  })

  it('runs a real sqlite backfill and reports sidebar-shaped measurements', async () => {
    const result = await runBenchmarkProcess([
      '--sessions',
      '8',
      '--entries-per-session',
      '8',
      '--runs',
      '1',
      '--warmup-runs',
      '1',
      '--seed',
      '78',
      '--mode',
      'sqlite',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as {
      mode: string
      fixture: { sessions: number; sidebarLimit: number; kept: boolean }
      index: {
        status: { mode: string; state: string; indexed: number }
      }
      measurement: {
        operation: string
        durationMs: { median: number; p95: number; max: number }
        productAppend: {
          measured: boolean
          watcherObserved: boolean
          messageCountDelta: number
          durationMs: number
        }
        sidebarApi: {
          measured: boolean
          limit: number
          rowCount: number
        }
        firstUsefulContent: {
          measured: boolean
          requestedImmediately: boolean
          rowCount: number
          durationMs: number
        }
        foregroundDuringBackfill: {
          measured: boolean
          requestCount: number
          successfulResponseCount: number
        }
        eventLoopDelay: {
          measured: boolean
          sampleCount: number
          p95Ms: number
          p99Ms: number
          maxMs: number
        }
        peakRss: {
          measured: boolean
          sampleCount: number
          peakBytes: number
        }
        loopbackAuth: {
          measured: boolean
          missingTokenStatus: number
          wrongTokenStatus: number
          correctTokenStatus: number
        }
      }
      validation: {
        expectedSessions: number
        actualSessions: number
        orderMatches: boolean
        summariesMatch: boolean
      }
    }
    expect(report).toMatchObject({
      mode: 'sqlite',
      fixture: {
        sessions: 8,
        sidebarLimit: 400,
        kept: false,
      },
      index: {
        status: { mode: 'on', state: 'ready', indexed: 8 },
      },
      measurement: {
        operation: 'sessions-http',
        productAppend: {
          measured: true,
          watcherObserved: true,
          messageCountDelta: 1,
        },
        sidebarApi: {
          measured: true,
          limit: 400,
          rowCount: 8,
        },
        firstUsefulContent: {
          measured: true,
          requestedImmediately: true,
        },
        foregroundDuringBackfill: {
          measured: true,
        },
        eventLoopDelay: { measured: true },
        peakRss: { measured: true },
        loopbackAuth: {
          measured: true,
          missingTokenStatus: 403,
          wrongTokenStatus: 403,
          correctTokenStatus: 200,
        },
      },
      validation: {
        expectedSessions: 8,
        actualSessions: 8,
        orderMatches: true,
        summariesMatch: true,
      },
    })
    expect(report.measurement.durationMs.p95).toBeGreaterThanOrEqual(0)
    expect(report.measurement.productAppend.durationMs).toBeGreaterThanOrEqual(0)
    expect(report.measurement.firstUsefulContent.rowCount).toBeGreaterThan(0)
    expect(report.measurement.firstUsefulContent.durationMs).toBeGreaterThanOrEqual(0)
    expect(report.measurement.foregroundDuringBackfill.requestCount).toBeGreaterThan(0)
    expect(report.measurement.foregroundDuringBackfill.successfulResponseCount).toBe(
      report.measurement.foregroundDuringBackfill.requestCount,
    )
    expect(report.measurement.eventLoopDelay.sampleCount).toBeGreaterThan(0)
    expect(report.measurement.eventLoopDelay.p95Ms).toBeGreaterThanOrEqual(0)
    expect(report.measurement.eventLoopDelay.p99Ms).toBeGreaterThanOrEqual(0)
    expect(report.measurement.eventLoopDelay.maxMs).toBeGreaterThanOrEqual(0)
    expect(report.measurement.peakRss.sampleCount).toBeGreaterThan(0)
    expect(report.measurement.peakRss.peakBytes).toBeGreaterThan(0)
  })
})
