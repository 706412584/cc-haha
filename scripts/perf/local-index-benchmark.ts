import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createLocalIndexCorpus } from './local-index-corpus.js'
import type { LocalIndexCoordinator } from '../../src/server/services/localIndex/coordinator.js'
import type {
  LocalIndexBinding,
  LocalIndexDatabase,
  LocalIndexReadOperation,
  LocalIndexWriteOperation,
} from '../../src/server/services/localIndex/database.js'
import type {
  SessionListShadowComparison,
} from '../../src/server/services/sessionService.js'
import type {
  LocalIndexGateway,
  SessionIndex,
} from '../../src/server/services/localIndex/sessionIndex.js'
import type {
  SessionProjector,
  SessionSourceCandidate,
} from '../../src/server/services/localIndex/sessionProjector.js'
import type { LocalIndexStatus } from '../../src/server/services/localIndex/types.js'

type BenchmarkMode = 'file' | 'sqlite' | 'shadow'
type BenchmarkScenario = 'baseline' | 'append'

export type BenchmarkOptions = {
  sessions: number
  entriesPerSession: number
  largeTranscriptBytes: number
  runs: number
  warmupRuns: number
  seed: number
  mode: BenchmarkMode
  scenario: BenchmarkScenario
  timeoutMs: number
  sidebarLimit: number
  keep: boolean
}

type ManifestSummary = {
  sourcePath: string
  sessionId: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
}

type CorpusManifest = {
  expected: {
    normalizedSessionOrder: string[]
    summaries: ManifestSummary[]
  }
  sources: Array<{
    path: string
    bytes: number
    sha256: string
  }>
  largeTranscript: {
    sourcePath: string
    requestedBytes: number
    actualBytes: number
  } | null
}

type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
}

type SessionListResult = {
  sessions: SessionListItem[]
  total: number
}

export type BenchmarkSampleContext = {
  phase: 'warmup' | 'measured'
  index: number
  rootDir: string
}

export type BenchmarkDependencies = {
  executeSessionList?: (
    execute: () => Promise<SessionListResult>,
    context: BenchmarkSampleContext,
  ) => Promise<SessionListResult>
  onProductGatesStart?: (context: { rootDir: string }) => void
}

type LoopbackSessionResponse = SessionListResult & {
  index: LocalIndexStatus
}

type LoopbackServer = {
  port: number
  stop(closeActiveConnections?: boolean): void
}

export class ProductGateTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`sqlite product gates exceeded ${timeoutMs}ms`)
    this.name = 'ProductGateTimeoutError'
  }
}

export class BenchmarkSampleTimeoutError extends Error {
  readonly timeoutCount = 1

  constructor(
    readonly phase: BenchmarkSampleContext['phase'],
    readonly index: number,
    readonly timeoutMs: number,
  ) {
    super(`${phase} sample ${index + 1} exceeded ${timeoutMs}ms; timeoutCount=1`)
    this.name = 'BenchmarkSampleTimeoutError'
  }
}

export async function runWithSampleDeadline<T>(options: {
  execute: () => Promise<T>
  timeoutMs: number
  phase: BenchmarkSampleContext['phase']
  index: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}): Promise<T> {
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const operation = Promise.resolve().then(options.execute)
    const timer = setTimer(() => {
      if (settled) return
      settled = true
      clearTimer(timer)
      reject(new BenchmarkSampleTimeoutError(
        options.phase,
        options.index,
        options.timeoutMs,
      ))
    }, options.timeoutMs)

    operation.then(
      value => {
        if (settled) return
        settled = true
        clearTimer(timer)
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        clearTimer(timer)
        reject(error)
      },
    )
  })
}

export async function captureStartupResponses<TFirst, TReady>(options: {
  firstUsefulRequest: Promise<TFirst>
  readyRequest: Promise<TReady>
  elapsedSinceServerStartMs: () => number
  onFirstUsefulSettled?: (durationMs: number) => void
}): Promise<{
  firstUseful: TFirst
  ready: TReady
  firstUsefulDurationMs: number
}> {
  const guardedReady = options.readyRequest.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
  const firstUseful = await options.firstUsefulRequest
  const firstUsefulDurationMs = options.elapsedSinceServerStartMs()
  options.onFirstUsefulSettled?.(firstUsefulDurationMs)
  const readyResult = await guardedReady
  if (!readyResult.ok) throw readyResult.error
  return { firstUseful, ready: readyResult.value, firstUsefulDurationMs }
}

type RecordedSql = {
  kind: 'get' | 'all' | 'run' | 'exec'
  sql: string
  bindings: LocalIndexBinding[]
}

type RecordingDatabase = {
  database: LocalIndexDatabase
  beginRecording(): void
  endRecording(): RecordedSql[]
}

export type DeterministicAcceptanceOptions = {
  sessions: number
  entriesPerSession: number
  seed: number
  readTranscriptBodyOpenCount: () => number
}

export type DeterministicAcceptanceReport = {
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
    measured: false
    reason: 'LOCAL_INDEX_RECONCILIATION_NOT_ACCEPTED'
  }
}

const DEFAULT_OPTIONS: BenchmarkOptions = {
  sessions: 500,
  entriesPerSession: 8,
  largeTranscriptBytes: 0,
  runs: 3,
  warmupRuns: 1,
  seed: 20260714,
  mode: 'file',
  scenario: 'baseline',
  timeoutMs: 120_000,
  sidebarLimit: 400,
  keep: false,
}

function integerArgument(
  name: string,
  rawValue: string | undefined,
  minimum: number,
): number {
  if (rawValue === undefined) {
    throw new Error(`${name} requires a value`)
  }
  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`)
  }
  return value
}

export function parseBenchmarkArgs(args: string[]): BenchmarkOptions {
  const options = { ...DEFAULT_OPTIONS }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--') continue
    if (argument === '--keep') {
      options.keep = true
      continue
    }
    const value = args[index + 1]
    if (argument === '--sessions') {
      options.sessions = integerArgument(argument, value, 1)
    } else if (argument === '--entries-per-session') {
      options.entriesPerSession = integerArgument(argument, value, 6)
    } else if (argument === '--large-transcript-bytes') {
      options.largeTranscriptBytes = integerArgument(argument, value, 0)
    } else if (argument === '--large-transcript-mib') {
      const mebibytes = integerArgument(argument, value, 1)
      const bytes = mebibytes * 1024 * 1024
      if (!Number.isSafeInteger(bytes)) {
        throw new Error('--large-transcript-mib is too large')
      }
      options.largeTranscriptBytes = bytes
    } else if (argument === '--runs') {
      options.runs = integerArgument(argument, value, 1)
    } else if (argument === '--warmup-runs') {
      options.warmupRuns = integerArgument(argument, value, 0)
    } else if (argument === '--seed') {
      options.seed = integerArgument(argument, value, 0)
    } else if (argument === '--timeout-ms') {
      options.timeoutMs = integerArgument(argument, value, 1)
    } else if (argument === '--sidebar-limit') {
      options.sidebarLimit = integerArgument(argument, value, 1)
    } else if (argument === '--mode') {
      if (value !== 'file' && value !== 'sqlite' && value !== 'shadow') {
        throw new Error('--mode must be file, sqlite, or shadow')
      }
      options.mode = value
    } else if (argument === '--scenario') {
      if (value !== 'baseline' && value !== 'append') {
        throw new Error('--scenario must be baseline or append')
      }
      options.scenario = value
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
    index += 1
  }
  return options
}

function percentile(samples: number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  return sorted[index]!
}

function roundedMilliseconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

function corpusFingerprint(manifest: CorpusManifest): string {
  const hash = createHash('sha256')
  for (const source of manifest.sources) {
    hash.update(`${source.path}\0${source.bytes}\0${source.sha256}\n`)
  }
  return hash.digest('hex')
}

function normalizedSessionKey(session: SessionListItem): string {
  return `${session.id}@projects/${session.projectPath}/${session.id}.jsonl`
}

function validateResult(
  result: SessionListResult,
  manifest: CorpusManifest,
  limit = Number.MAX_SAFE_INTEGER,
): {
  expectedSessions: number
  actualSessions: number
  orderMatches: boolean
  summariesMatch: boolean
} {
  const actualOrder = result.sessions.map(normalizedSessionKey)
  const expectedOrder = manifest.expected.normalizedSessionOrder.slice(0, limit)
  const expectedBySource = new Map(
    manifest.expected.summaries.map(summary => [summary.sourcePath, summary]),
  )
  const summariesMatch = result.sessions.every(session => {
    const source = `projects/${session.projectPath}/${session.id}.jsonl`
    const expected = expectedBySource.get(source)
    return expected !== undefined &&
      session.id === expected.sessionId &&
      session.title === expected.title &&
      session.createdAt === expected.createdAt &&
      session.modifiedAt === expected.modifiedAt &&
      session.messageCount === expected.messageCount
  })

  return {
    expectedSessions: manifest.expected.summaries.length,
    actualSessions: result.total,
    orderMatches:
      JSON.stringify(actualOrder) ===
      JSON.stringify(expectedOrder),
    summariesMatch:
      summariesMatch && result.sessions.length === expectedOrder.length,
  }
}

function restoreEnvironment(
  name:
    | 'HOME'
    | 'CLAUDE_CONFIG_DIR'
    | 'CC_HAHA_LOCAL_INDEX'
    | 'CC_HAHA_LOCAL_ACCESS_TOKEN',
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function createRecordingDatabase(target: LocalIndexDatabase): RecordingDatabase {
  let recording = false
  let records: RecordedSql[] = []
  const record = (
    kind: RecordedSql['kind'],
    sql: string,
    bindings: LocalIndexBinding[] = [],
  ): void => {
    if (recording) records.push({ kind, sql, bindings: [...bindings] })
  }
  const readOperation = (
    operation: LocalIndexReadOperation,
  ): LocalIndexReadOperation => ({
    get<T>(sql: string, ...bindings: LocalIndexBinding[]): T | null {
      record('get', sql, bindings)
      return operation.get<T>(sql, ...bindings)
    },
    all<T>(sql: string, ...bindings: LocalIndexBinding[]): T[] {
      record('all', sql, bindings)
      return operation.all<T>(sql, ...bindings)
    },
  })
  const writeOperation = (
    operation: LocalIndexWriteOperation,
  ): LocalIndexWriteOperation => ({
    ...readOperation(operation),
    run(sql: string, ...bindings: LocalIndexBinding[]) {
      record('run', sql, bindings)
      return operation.run(sql, ...bindings)
    },
    exec(sql: string): void {
      record('exec', sql)
      operation.exec(sql)
    },
  })

  return {
    database: {
      read: callback => target.read(operation => callback(readOperation(operation))),
      write: callback => target.write(operation => callback(writeOperation(operation))),
      transaction: callback => target.transaction(
        operation => callback(writeOperation(operation)),
      ),
      close: () => target.close(),
    },
    beginRecording(): void {
      records = []
      recording = true
    },
    endRecording(): RecordedSql[] {
      recording = false
      return records.map(entry => ({
        ...entry,
        bindings: [...entry.bindings],
      }))
    },
  }
}

async function hashManifestSources(
  configDir: string,
  sources: CorpusManifest['sources'],
): Promise<Map<string, { bytes: number; sha256: string }>> {
  const hashes = new Map<string, { bytes: number; sha256: string }>()
  for (const source of sources) {
    const content = await readFile(join(configDir, source.path))
    hashes.set(source.path, {
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
  }
  return hashes
}

function hashesMatchManifest(
  hashes: Map<string, { bytes: number; sha256: string }>,
  sources: CorpusManifest['sources'],
): boolean {
  return sources.every(source => {
    const actual = hashes.get(source.path)
    return actual?.bytes === source.bytes && actual.sha256 === source.sha256
  })
}

function rowMap(
  rows: Array<Record<string, unknown>>,
  key: string,
): Map<string, string> {
  return new Map(rows.map(row => [String(row[key]), JSON.stringify(row)]))
}

function changedRowKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys]
    .filter(key => before.get(key) !== after.get(key))
    .sort()
}

function requireSql(
  records: RecordedSql[],
  predicate: (record: RecordedSql) => boolean,
  label: string,
): RecordedSql {
  const record = records.find(predicate)
  if (!record) throw new Error(`acceptance did not capture ${label} SQL`)
  return record
}

function createOnGateway(coordinator: LocalIndexCoordinator): LocalIndexGateway {
  return {
    start: () => coordinator.start(),
    stop: () => coordinator.stop(),
    getMode: () => 'on',
    getPublicStatus: () => coordinator.getPublicStatus(),
    isSessionScopeReady: () => coordinator.isSessionScopeReady(),
    rebuild: () => coordinator.rebuild(),
    listSessions: options => coordinator.listSessions(options),
    findSessionFiles: sessionId => coordinator.findSessionFiles(sessionId),
  }
}

async function waitForIndexReady(
  coordinator: LocalIndexCoordinator,
  timeoutMs: number,
): Promise<LocalIndexStatus> {
  const startedAt = Bun.nanoseconds()
  while (true) {
    const status = coordinator.getPublicStatus()
    if (status.state === 'ready') return status
    if (status.state === 'degraded') {
      throw new Error(
        `local index degraded before ready: ${status.lastErrorCode ?? 'LOCAL_INDEX_UNKNOWN'}`,
      )
    }
    const elapsedMs = (Bun.nanoseconds() - startedAt) / 1_000_000
    if (elapsedMs > timeoutMs) {
      throw new Error(`local index did not become ready within ${timeoutMs}ms`)
    }
    await Bun.sleep(5)
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('sqlite product gates aborted')
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolveSleep, rejectSleep) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveSleep()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectSleep(signal.reason instanceof Error
        ? signal.reason
        : new Error('sqlite product gates aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function eventLoopMilliseconds(nanoseconds: number): number {
  return Number.isFinite(nanoseconds)
    ? roundedMilliseconds(nanoseconds / 1_000_000)
    : 0
}

export async function runSqliteProductBenchmark(
  options: BenchmarkOptions,
  context: {
    rootDir: string
    configDir: string
    manifestPath: string
    manifest: CorpusManifest
    localAccessToken: string
  },
  dependencies: BenchmarkDependencies = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const deadline = setTimeout(() => {
    controller.abort(new ProductGateTimeoutError(options.timeoutMs))
  }, options.timeoutMs)
  const signal = controller.signal
  const eventLoop = monitorEventLoopDelay({ resolution: 10 })
  const rssBaselineBytes = process.memoryUsage().rss
  let peakRssBytes = rssBaselineBytes
  let rssSampleCount = 1
  const sampleRss = (): void => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
    rssSampleCount += 1
  }
  const rssSampler = setInterval(sampleRss, 5)
  rssSampler.unref?.()
  eventLoop.enable()

  let server: LoopbackServer | undefined
  let stopServerRuntime: (() => Promise<void>) | undefined
  let coordinator: LocalIndexCoordinator | undefined
  let operationError: unknown
  let monitorStopped = false
  const originalConsoleLog = console.log
  const originalConsoleInfo = console.info
  const originalConsoleWarn = console.warn
  console.log = () => {}
  console.info = () => {}
  console.warn = () => {}

  const stopMonitors = (): void => {
    if (monitorStopped) return
    monitorStopped = true
    clearInterval(rssSampler)
    sampleRss()
    eventLoop.disable()
  }

  try {
    dependencies.onProductGatesStart?.({ rootDir: context.rootDir })
    const serverModule = await import('../../src/server/index.js')
    const coordinatorModule = await import(
      '../../src/server/services/localIndex/coordinator.js'
    )
    coordinator = coordinatorModule.localIndexCoordinator
    stopServerRuntime = () => serverModule.stopServerRuntimeForShutdown({
      waitForCli: true,
    })

    const serverStartedAt = Bun.nanoseconds()
    server = serverModule.startServer(0, '127.0.0.1')
    const baseUrl = `http://127.0.0.1:${server.port}`

    const requestSessions = async (): Promise<{
      body: LoopbackSessionResponse
      durationMs: number
      status: number
    }> => {
      throwIfAborted(signal)
      const startedAt = Bun.nanoseconds()
      let response: Response
      try {
        response = await fetch(
          `${baseUrl}/api/sessions?limit=${options.sidebarLimit}&offset=0`,
          {
            signal,
            headers: {
              Authorization: `Bearer ${context.localAccessToken}`,
            },
          },
        )
      } catch (error) {
        throwIfAborted(signal)
        throw error
      }
      if (!response.ok) {
        throw new Error(`sessions HTTP returned ${response.status}`)
      }
      const body = await response.json() as LoopbackSessionResponse
      if (
        !Array.isArray(body.sessions) ||
        !Number.isSafeInteger(body.total) ||
        !body.index ||
        typeof body.index.state !== 'string'
      ) {
        throw new Error('sessions HTTP returned an invalid product response')
      }
      sampleRss()
      return {
        body,
        durationMs: (Bun.nanoseconds() - startedAt) / 1_000_000,
        status: response.status,
      }
    }

    const immediateRequestOffsetMs =
      (Bun.nanoseconds() - serverStartedAt) / 1_000_000
    const expectedReadyRows = Math.min(
      options.sidebarLimit,
      context.manifest.expected.summaries.length,
    )
    const firstUsefulRequest = requestSessions()
    const foregroundDurations: number[] = []
    let foregroundSuccessfulResponses = 0
    let foregroundBuildingResponses = 0
    const readyRequest = (async () => {
      while (true) {
        const result = await requestSessions()
        foregroundDurations.push(result.durationMs)
        foregroundSuccessfulResponses += 1
        if (result.body.index.state === 'degraded') {
          throw new Error(
            `local index degraded during foreground polling: ${result.body.index.lastErrorCode ?? 'LOCAL_INDEX_UNKNOWN'}`,
          )
        }
        if (result.body.index.state === 'building') {
          foregroundBuildingResponses += 1
        }
        if (
          result.body.index.state === 'ready' &&
          result.body.total === context.manifest.expected.summaries.length &&
          result.body.sessions.length === expectedReadyRows
        ) {
          return result
        }
        await sleepWithSignal(5, signal)
      }
    })()

    const { firstUseful, ready, firstUsefulDurationMs } =
      await captureStartupResponses({
        firstUsefulRequest,
        readyRequest,
        elapsedSinceServerStartMs: () =>
          (Bun.nanoseconds() - serverStartedAt) / 1_000_000,
      })
    if (firstUseful.body.sessions.length === 0) {
      throw new Error('immediate sessions HTTP did not return useful content')
    }
    if (
      ready.body.total !== context.manifest.expected.summaries.length ||
      ready.body.sessions.length !== expectedReadyRows
    ) {
      throw new Error(`ready sessions HTTP was incomplete: ${JSON.stringify({
        expectedTotal: context.manifest.expected.summaries.length,
        actualTotal: ready.body.total,
        expectedRows: expectedReadyRows,
        actualRows: ready.body.sessions.length,
      })}`)
    }
    const readyDurationMs =
      (Bun.nanoseconds() - serverStartedAt) / 1_000_000

    const authProbeUrl =
      `${baseUrl}/api/sessions?limit=${Math.min(1, options.sidebarLimit)}&offset=0`
    const [missingTokenResponse, wrongTokenResponse] = await Promise.all([
      fetch(authProbeUrl, { signal }),
      fetch(authProbeUrl, {
        signal,
        headers: { Authorization: 'Bearer wrong-local-access-token' },
      }),
    ])
    const loopbackAuth = {
      measured: true,
      missingTokenStatus: missingTokenResponse.status,
      wrongTokenStatus: wrongTokenResponse.status,
      correctTokenStatus: firstUseful.status,
    }
    if (
      loopbackAuth.missingTokenStatus !== 403 ||
      loopbackAuth.wrongTokenStatus !== 403 ||
      loopbackAuth.correctTokenStatus !== 200
    ) {
      throw new Error(`loopback local-access auth proof failed: ${JSON.stringify(loopbackAuth)}`)
    }

    const execute = async (): Promise<SessionListResult> => {
      const result = await requestSessions()
      return {
        sessions: result.body.sessions,
        total: result.body.total,
      }
    }
    const executeDeadlineSample = (
      phase: BenchmarkSampleContext['phase'],
      index: number,
    ): Promise<SessionListResult> => runWithSampleDeadline({
      execute: () => dependencies.executeSessionList
        ? dependencies.executeSessionList(execute, {
            phase,
            index,
            rootDir: context.rootDir,
          })
        : execute(),
      timeoutMs: options.timeoutMs,
      phase,
      index,
    })

    for (let index = 0; index < options.warmupRuns; index += 1) {
      await executeDeadlineSample('warmup', index)
    }
    const samples: number[] = []
    const cpuStart = process.cpuUsage()
    const rssStart = process.memoryUsage().rss
    let lastResult: SessionListResult | undefined
    for (let index = 0; index < options.runs; index += 1) {
      const startedAt = Bun.nanoseconds()
      lastResult = await executeDeadlineSample('measured', index)
      samples.push((Bun.nanoseconds() - startedAt) / 1_000_000)
    }
    const cpu = process.cpuUsage(cpuStart)
    const fileValidation = validateResult(
      lastResult!,
      context.manifest,
      options.sidebarLimit,
    )
    if (
      fileValidation.actualSessions !== fileValidation.expectedSessions ||
      !fileValidation.orderMatches ||
      !fileValidation.summariesMatch
    ) {
      throw new Error(`sessions HTTP did not match the corpus manifest: ${JSON.stringify(fileValidation)}`)
    }

    const appendTarget = ready.body.sessions[0]
    if (!appendTarget) throw new Error('product append has no target session')
    const appendPath = join(
      context.configDir,
      'projects',
      appendTarget.projectPath,
      `${appendTarget.id}.jsonl`,
    )
    await stat(appendPath)
    const appendStartedAt = Bun.nanoseconds()
    await appendFile(appendPath, `${JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'assistant',
      message: {
        id: 'msg_product_watcher_append',
        type: 'message',
        role: 'assistant',
        model: 'claude-synthetic-benchmark',
        content: [{ type: 'text', text: 'Product watcher append' }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: 'product-watcher-append-entry',
      timestamp: '2099-12-31T23:59:59.000Z',
    })}\n`)
    const { SessionService } = await import(
      '../../src/server/services/sessionService.js'
    )
    let appendedMessageCount = appendTarget.messageCount
    let appendPollCount = 0
    while (true) {
      throwIfAborted(signal)
      appendPollCount += 1
      const status = coordinator.getPublicStatus()
      if (status.state === 'degraded') {
        throw new Error(
          `local index degraded during product append: ${status.lastErrorCode ?? 'LOCAL_INDEX_UNKNOWN'}`,
        )
      }
      const result = await new SessionService(
        createOnGateway(coordinator),
      ).listSessions({ limit: options.sidebarLimit, offset: 0 })
      const updated = result.sessions.find(session =>
        session.id === appendTarget.id &&
        session.projectPath === appendTarget.projectPath,
      )
      appendedMessageCount = updated?.messageCount ?? appendTarget.messageCount
      if (
        appendedMessageCount === appendTarget.messageCount + 1 &&
        status.state === 'ready'
      ) {
        break
      }
      await sleepWithSignal(5, signal)
    }
    const appendDurationMs =
      (Bun.nanoseconds() - appendStartedAt) / 1_000_000

    stopMonitors()
    const median = percentile(samples, 0.5)
    const p95 = percentile(samples, 0.95)
    const max = Math.max(...samples)
    const eventLoopSampleCount = Number(eventLoop.count)
    return {
      schemaVersion: 1,
      mode: options.mode,
      scenario: options.scenario,
      fixture: {
        rootDir: context.rootDir,
        configDir: context.configDir,
        manifestPath: context.manifestPath,
        seed: options.seed,
        sessions: options.sessions,
        entriesPerSession: options.entriesPerSession,
        largeTranscriptBytes: options.largeTranscriptBytes,
        sidebarLimit: options.sidebarLimit,
        corpusFingerprint: corpusFingerprint(context.manifest),
        kept: options.keep,
      },
      measurement: {
        operation: 'sessions-http',
        warmupRuns: options.warmupRuns,
        runs: options.runs,
        durationMs: {
          median: roundedMilliseconds(median),
          p95: roundedMilliseconds(p95),
          max: roundedMilliseconds(max),
        },
        timeoutMs: options.timeoutMs,
        timeoutCount: 0,
        cpuMs: {
          user: roundedMilliseconds(cpu.user / 1000),
          system: roundedMilliseconds(cpu.system / 1000),
          total: roundedMilliseconds((cpu.user + cpu.system) / 1000),
        },
        rssDeltaBytes: process.memoryUsage().rss - rssStart,
        io: {
          instrumented: false,
          filesOpened: null,
          bytesRead: null,
        },
        productAppend: {
          measured: true,
          watcherObserved: true,
          messageCountDelta: appendedMessageCount - appendTarget.messageCount,
          durationMs: roundedMilliseconds(appendDurationMs),
          pollCount: appendPollCount,
          finalState: coordinator.getPublicStatus().state,
        },
        referenceHardware: {
          measured: false,
          reason: 'REFERENCE_HARDWARE_NOT_RUN',
        },
        sidebarApi: {
          measured: true,
          transport: 'loopback-http',
          limit: options.sidebarLimit,
          rowCount: lastResult!.sessions.length,
          total: lastResult!.total,
        },
        firstUsefulContent: {
          measured: true,
          requestedImmediately: true,
          requestOffsetMs: roundedMilliseconds(immediateRequestOffsetMs),
          rowCount: firstUseful.body.sessions.length,
          total: firstUseful.body.total,
          durationMs: roundedMilliseconds(firstUsefulDurationMs),
          indexState: firstUseful.body.index.state,
        },
        foregroundDuringBackfill: {
          measured: true,
          requestCount: foregroundDurations.length,
          successfulResponseCount: foregroundSuccessfulResponses,
          buildingResponseCount: foregroundBuildingResponses,
          durationMs: {
            p95: roundedMilliseconds(percentile(foregroundDurations, 0.95)),
            max: roundedMilliseconds(Math.max(...foregroundDurations)),
          },
        },
        eventLoopDelay: {
          measured: true,
          sampleCount: eventLoopSampleCount,
          meanMs: eventLoopMilliseconds(eventLoop.mean),
          p95Ms: eventLoopMilliseconds(eventLoop.percentile(95)),
          p99Ms: eventLoopMilliseconds(eventLoop.percentile(99)),
          maxMs: eventLoopMilliseconds(eventLoop.max),
        },
        peakRss: {
          measured: true,
          sampleCount: rssSampleCount,
          baselineBytes: rssBaselineBytes,
          peakBytes: peakRssBytes,
          peakDeltaBytes: peakRssBytes - rssBaselineBytes,
        },
        loopbackAuth,
      },
      index: {
        readyDurationMs: roundedMilliseconds(readyDurationMs),
        status: coordinator.getPublicStatus(),
        scheduling: coordinator.getSchedulingMetrics(),
      },
      validation: fileValidation,
    }
  } catch (error) {
    operationError = signal.aborted && signal.reason instanceof Error
      ? signal.reason
      : error
    throw operationError
  } finally {
    clearTimeout(deadline)
    stopMonitors()
    let cleanupError: unknown
    try {
      server?.stop(true)
    } catch (error) {
      cleanupError = error
    }
    try {
      await stopServerRuntime?.()
    } catch (error) {
      cleanupError ??= error
    }
    console.log = originalConsoleLog
    console.info = originalConsoleInfo
    console.warn = originalConsoleWarn
    if (cleanupError && operationError === undefined) throw cleanupError
  }
}

const APPEND_BYTES = 4 * 1024
const APPEND_IO_LIMIT_BYTES = 1024 * 1024

function createAppendPayload(): Buffer {
  const prefix = '{"type":"progress","marker":"synthetic-append","data":"'
  const suffix = '"}\n'
  const dataBytes = APPEND_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  if (dataBytes < 0) throw new Error('append payload envelope exceeds target size')
  const payload = Buffer.from(`${prefix}${'x'.repeat(dataBytes)}${suffix}`)
  if (payload.length !== APPEND_BYTES) {
    throw new Error(`append payload must be exactly ${APPEND_BYTES} bytes`)
  }
  return payload
}

async function runAppendScenario(options: BenchmarkOptions, context: {
  rootDir: string
  manifest: CorpusManifest
  manifestPath: string
  configDir: string
}) {
  const largeTranscript = context.manifest.largeTranscript
  if (!largeTranscript) {
    throw new Error('append scenario requires --large-transcript-mib or --large-transcript-bytes')
  }
  const sourcePath = join(context.configDir, largeTranscript.sourcePath)
  const { SessionService } = await import('../../src/server/services/sessionService.js')
  const baseline = await new SessionService().listSessions({
    limit: Number.MAX_SAFE_INTEGER,
  })
  const baselineValidation = validateResult(baseline, context.manifest)
  if (
    baselineValidation.actualSessions !== baselineValidation.expectedSessions ||
    !baselineValidation.orderMatches ||
    !baselineValidation.summariesMatch
  ) {
    throw new Error(`append baseline did not match the corpus manifest: ${JSON.stringify(baselineValidation)}`)
  }

  const {
    captureSourceFingerprint,
    detectSourceChange,
    verifySourceFingerprint,
  } = await import('../../src/server/services/localIndex/sourceFingerprint.js')
  const { readCompleteJsonlRange } = await import(
    '../../src/server/services/localIndex/fileReader.js'
  )
  const beforeAppend = await stat(sourcePath)
  const previous = await captureSourceFingerprint({
    path: sourcePath,
    indexedBytes: beforeAppend.size,
    parserVersion: 1,
  })
  const payload = createAppendPayload()
  await appendFile(sourcePath, payload)

  const execute = async () => {
    const io = { filesOpened: 0, bytesRead: 0, statCalls: 0 }
    const change = await detectSourceChange({
      path: sourcePath,
      previous,
      parserVersion: 1,
      metrics: io,
    })
    if (change.kind !== 'append') {
      throw new Error(`append scenario expected append, received ${JSON.stringify(change)}`)
    }
    const range = await readCompleteJsonlRange({
      path: sourcePath,
      start: change.readFrom,
      metrics: io,
    })
    const current = await captureSourceFingerprint({
      path: sourcePath,
      indexedBytes: range.nextOffset,
      parserVersion: 1,
      metrics: io,
    })
    const verified = await verifySourceFingerprint({
      path: sourcePath,
      expected: current,
      metrics: io,
    })
    return { change, range, verified, io }
  }

  for (let index = 0; index < options.warmupRuns; index += 1) {
    await runWithSampleDeadline({
      execute,
      timeoutMs: options.timeoutMs,
      phase: 'warmup',
      index,
    })
  }

  const samples: number[] = []
  const ioSamples: Array<{ filesOpened: number; bytesRead: number; statCalls: number }> = []
  const cpuStart = process.cpuUsage()
  const rssStart = process.memoryUsage().rss
  let lastResult: Awaited<ReturnType<typeof execute>> | undefined
  for (let index = 0; index < options.runs; index += 1) {
    const startedAt = Bun.nanoseconds()
    lastResult = await runWithSampleDeadline({
      execute,
      timeoutMs: options.timeoutMs,
      phase: 'measured',
      index,
    })
    const durationMs = (Bun.nanoseconds() - startedAt) / 1_000_000
    samples.push(durationMs)
    ioSamples.push(lastResult.io)
  }
  const maxBytesReadPerRun = Math.max(...ioSamples.map(io => io.bytesRead))
  if (maxBytesReadPerRun > APPEND_IO_LIMIT_BYTES) {
    throw new Error(
      `append fingerprint+range-read exceeded ${APPEND_IO_LIMIT_BYTES} bytes: ${maxBytesReadPerRun}`,
    )
  }
  const cpu = process.cpuUsage(cpuStart)
  const median = percentile(samples, 0.5)
  const p95 = percentile(samples, 0.95)
  const max = Math.max(...samples)
  const totals = ioSamples.reduce(
    (total, io) => ({
      filesOpened: total.filesOpened + io.filesOpened,
      bytesRead: total.bytesRead + io.bytesRead,
      statCalls: total.statCalls + io.statCalls,
    }),
    { filesOpened: 0, bytesRead: 0, statCalls: 0 },
  )
  const last = lastResult!

  return {
    schemaVersion: 1,
    mode: options.mode,
    scenario: options.scenario,
    operation: 'fingerprint+range-read',
    fixture: {
      rootDir: context.rootDir,
      configDir: context.configDir,
      manifestPath: context.manifestPath,
      seed: options.seed,
      sessions: options.sessions,
      entriesPerSession: options.entriesPerSession,
      largeTranscriptBytes: options.largeTranscriptBytes,
      actualLargeTranscriptBytes: largeTranscript.actualBytes,
      appendBytes: payload.length,
      corpusFingerprint: corpusFingerprint(context.manifest),
      kept: options.keep,
    },
    measurement: {
      warmupRuns: options.warmupRuns,
      runs: options.runs,
      durationMs: {
        median: roundedMilliseconds(median),
        p95: roundedMilliseconds(p95),
        max: roundedMilliseconds(max),
      },
      timeoutMs: options.timeoutMs,
      timeoutCount: 0,
      cpuMs: {
        user: roundedMilliseconds(cpu.user / 1000),
        system: roundedMilliseconds(cpu.system / 1000),
        total: roundedMilliseconds((cpu.user + cpu.system) / 1000),
      },
      rssDeltaBytes: process.memoryUsage().rss - rssStart,
      io: {
        instrumented: true,
        ...totals,
        maxBytesReadPerRun,
        limitBytes: APPEND_IO_LIMIT_BYTES,
        withinLimit: maxBytesReadPerRun <= APPEND_IO_LIMIT_BYTES,
      },
    },
    validation: {
      changeKind: last.change.kind,
      nextOffsetAdvancedBy: last.range.nextOffset - previous.indexedBytes,
      pendingTailBytes: last.range.pendingTailBytes,
      snapshotVerified: last.verified.kind === 'unchanged',
    },
  }
}

export async function runDeterministicAcceptance(
  options: DeterministicAcceptanceOptions,
): Promise<DeterministicAcceptanceReport> {
  const rootDir = await mkdtemp(join(tmpdir(), 'cc-haha-local-index-acceptance-'))
  const homeDir = join(rootDir, 'home')
  const configDir = join(homeDir, '.claude')
  const databasePath = join(configDir, 'cc-haha', 'db', 'index-v1.sqlite')
  const originalHome = process.env.HOME
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalLocalIndexMode = process.env.CC_HAHA_LOCAL_INDEX
  let coordinator: LocalIndexCoordinator | undefined

  try {
    await mkdir(homeDir, { recursive: true })
    process.env.HOME = homeDir
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CC_HAHA_LOCAL_INDEX = 'shadow'

    const corpus = await createLocalIndexCorpus({
      rootDir,
      sessions: options.sessions,
      entriesPerSession: options.entriesPerSession,
      seed: options.seed,
    })
    const manifest = JSON.parse(
      await readFile(corpus.manifestPath, 'utf8'),
    ) as CorpusManifest
    const targetPath = corpus.transcriptPaths[0]!
    // The corpus normally aligns physical mtime with semantic modifiedAt. Move
    // one physical mtime forward before indexing so the projector can prove a
    // same-process append from reducer state instead of conservatively taking
    // its file-mtime-fallback rebuild branch. Source bytes remain untouched.
    const appendFixtureMtime = new Date('2080-01-01T00:00:00.000Z')
    await utimes(targetPath, appendFixtureMtime, appendFixtureMtime)
    const expectedFingerprint = corpusFingerprint(manifest)
    const projectionIo = { filesOpened: 0, bytesRead: 0, statCalls: 0 }
    let recordingDatabase: RecordingDatabase | undefined
    let activeIndex: SessionIndex | undefined
    let activeProjector: SessionProjector | undefined

    const {
      createLocalIndexCoordinator,
    } = await import('../../src/server/services/localIndex/coordinator.js')
    const {
      openLocalIndexDatabase,
    } = await import('../../src/server/services/localIndex/database.js')
    const {
      createSessionIndex,
    } = await import('../../src/server/services/localIndex/sessionIndex.js')
    const {
      createSessionProjector,
    } = await import('../../src/server/services/localIndex/sessionProjector.js')

    coordinator = createLocalIndexCoordinator({
      resolveMode: () => ({ mode: 'shadow', warningCode: null }),
      resolveScope: () => corpus.configDir,
      resolveDatabasePath: () => databasePath,
      openDatabase: path => {
        recordingDatabase = createRecordingDatabase(
          openLocalIndexDatabase({ path }),
        )
        return recordingDatabase.database
      },
      createIndex: database => {
        activeIndex = createSessionIndex(database)
        return activeIndex
      },
      createProjector: projectorOptions => {
        activeProjector = createSessionProjector({
          ...projectorOptions,
          metrics: projectionIo,
        })
        return activeProjector
      },
      // Task 8 owns watcher/recovery behavior. Keep this Task 9 proof scoped to
      // one deterministic startup generation so incidental filesystem events
      // cannot turn the scheduling invariant into a timing-dependent count.
      createWatcher: () => ({
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
      }),
      yieldToForeground: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
    })

    await coordinator.start()
    const readyStatus = await waitForIndexReady(coordinator, 120_000)
    if (!recordingDatabase || !activeIndex || !activeProjector) {
      throw new Error('acceptance coordinator did not initialize its production dependencies')
    }
    if (
      readyStatus.indexed !== options.sessions ||
      readyStatus.discovered !== options.sessions ||
      readyStatus.degradedSources !== 0
    ) {
      throw new Error(`acceptance backfill was incomplete: ${JSON.stringify(readyStatus)}`)
    }

    const afterBackfillHashes = await hashManifestSources(
      corpus.configDir,
      manifest.sources,
    )
    const unchangedAfterBackfill = hashesMatchManifest(
      afterBackfillHashes,
      manifest.sources,
    )

    const pageSize = 100
    const page100Offset = 9_900
    recordingDatabase.beginRecording()
    const page1 = activeIndex.listSessions({ limit: pageSize, offset: 0 })
    const page1Sql = recordingDatabase.endRecording()
    recordingDatabase.beginRecording()
    const page100 = activeIndex.listSessions({
      limit: pageSize,
      offset: page100Offset,
    })
    const page100Sql = recordingDatabase.endRecording()
    const globalSelect = requireSql(
      page1Sql,
      record => record.kind === 'all' &&
        /FROM\s+sessions/i.test(record.sql) &&
        /ORDER\s+BY/i.test(record.sql),
      'global session list',
    )
    const globalPlan = recordingDatabase.database.read(operation =>
      operation.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${globalSelect.sql}`,
        ...globalSelect.bindings,
      ).map(row => row.detail),
    )

    const projectPath = page1.sessions[0]?.projectPath
    if (!projectPath) throw new Error('acceptance page 1 unexpectedly returned no sessions')
    recordingDatabase.beginRecording()
    activeIndex.listSessions({ project: projectPath, limit: pageSize, offset: 0 })
    const projectSql = recordingDatabase.endRecording()
    const projectSelect = requireSql(
      projectSql,
      record => record.kind === 'all' &&
        /FROM\s+sessions/i.test(record.sql) &&
        /WHERE\s+project_path\s*=\s*\?/i.test(record.sql),
      'project session list',
    )
    const projectPlan = recordingDatabase.database.read(operation =>
      operation.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${projectSelect.sql}`,
        ...projectSelect.bindings,
      ).map(row => row.detail),
    )

    const hasBareSessionScan = (details: string[]): boolean => details.some(
      detail => /^SCAN sessions$/i.test(detail.trim()),
    )
    const normalizedIndexedKey = (row: { id: string; transcriptPath: string }): string =>
      `${row.id}@${relative(corpus.configDir, row.transcriptPath).split(sep).join('/')}`
    const page1OrderMatches = page1.sessions.map(normalizedIndexedKey)
      .every((key, index) => key === manifest.expected.normalizedSessionOrder[index])
    const page100OrderMatches = page100.sessions.map(normalizedIndexedKey)
      .every((key, index) =>
        key === manifest.expected.normalizedSessionOrder[page100Offset + index],
      )
    if (
      !globalPlan.some(detail => detail.includes('sessions_modified_idx')) ||
      !projectPlan.some(detail => detail.includes('sessions_project_modified_idx')) ||
      hasBareSessionScan(globalPlan) ||
      hasBareSessionScan(projectPlan) ||
      [...globalPlan, ...projectPlan].some(
        detail => /source_files|USE TEMP B-TREE/i.test(detail),
      ) ||
      !page1OrderMatches ||
      !page100OrderMatches
    ) {
      throw new Error(`acceptance indexed pages were invalid: ${JSON.stringify({
        globalPlan,
        projectPlan,
        page1OrderMatches,
        page100OrderMatches,
      })}`)
    }

    const { SessionService } = await import(
      '../../src/server/services/sessionService.js'
    )
    const transcriptOpensBefore = options.readTranscriptBodyOpenCount()
    const indexedResult = await new SessionService(
      createOnGateway(coordinator),
    ).listSessions({ limit: 400, offset: 0 })
    const transcriptBodyOpens =
      options.readTranscriptBodyOpenCount() - transcriptOpensBefore

    const sourceRowsBefore = recordingDatabase.database.read(operation =>
      operation.all<Record<string, unknown>>(
        'SELECT * FROM source_files ORDER BY path ASC',
      ),
    )
    const sessionRowsBefore = recordingDatabase.database.read(operation =>
      operation.all<Record<string, unknown>>(
        'SELECT * FROM sessions ORDER BY transcript_path ASC',
      ),
    )
    const targetRelativePath = relative(corpus.configDir, targetPath)
      .split(sep)
      .join('/')
    const targetSessionBefore = sessionRowsBefore.find(
      row => row.transcript_path === targetPath,
    )
    const previousMessageCount = Number(targetSessionBefore?.message_count)
    const appendTimestamp = '2099-01-01T00:00:00.000Z'
    await appendFile(targetPath, `${JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'assistant',
      message: {
        id: 'msg_acceptance_append',
        type: 'message',
        role: 'assistant',
        model: 'claude-synthetic-benchmark',
        content: [{ type: 'text', text: 'Deterministic acceptance append' }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: 'acceptance-append-entry',
      timestamp: appendTimestamp,
    })}\n`)
    const targetStat = await stat(targetPath)
    const candidate: SessionSourceCandidate = {
      path: targetPath,
      sessionId: basename(targetPath, '.jsonl'),
      projectPath: basename(dirname(targetPath)),
      fallbackCreatedAt: targetStat.birthtime.toISOString(),
      fallbackModifiedAt: targetStat.mtime.toISOString(),
      fallbackWorkDir: null,
      modifiedAtMs: targetStat.mtimeMs,
    }
    const appendResult = await activeProjector.projectSource(candidate, {
      state: 'ready',
      discovered: options.sessions,
      indexed: options.sessions,
      degraded: 0,
      lastErrorCode: null,
    })

    const sourceRowsAfter = recordingDatabase.database.read(operation =>
      operation.all<Record<string, unknown>>(
        'SELECT * FROM source_files ORDER BY path ASC',
      ),
    )
    const sessionRowsAfter = recordingDatabase.database.read(operation =>
      operation.all<Record<string, unknown>>(
        'SELECT * FROM sessions ORDER BY transcript_path ASC',
      ),
    )
    const changedSourceRows = changedRowKeys(
      rowMap(sourceRowsBefore, 'path'),
      rowMap(sourceRowsAfter, 'path'),
    )
    const changedSessionRows = changedRowKeys(
      rowMap(sessionRowsBefore, 'transcript_path'),
      rowMap(sessionRowsAfter, 'transcript_path'),
    )
    const targetSessionAfter = sessionRowsAfter.find(
      row => row.transcript_path === targetPath,
    )
    const messageCountDelta =
      Number(targetSessionAfter?.message_count) - previousMessageCount

    const afterAppendHashes = await hashManifestSources(
      corpus.configDir,
      manifest.sources,
    )
    const changedCorpusSources = manifest.sources.filter(source => {
      const current = afterAppendHashes.get(source.path)
      return current?.bytes !== source.bytes || current.sha256 !== source.sha256
    })
    const unrelatedSourcesUnchangedAfterAppend = changedCorpusSources.every(
      source => source.path === targetRelativePath,
    )
    if (
      changedSourceRows.length !== 1 ||
      changedSourceRows[0] !== targetPath ||
      changedSessionRows.length !== 1 ||
      changedSessionRows[0] !== targetPath
    ) {
      throw new Error(`acceptance append changed unrelated projection rows: ${JSON.stringify({
        targetPath,
        changedSourceRows,
        changedSessionRows,
      })}`)
    }

    const shadowComparisons: SessionListShadowComparison[] = []
    const shadowTranscriptOpensBefore = options.readTranscriptBodyOpenCount()
    await new SessionService(coordinator, {
      shadowComparisonMinIntervalMs: 0,
      recordShadowComparison: comparison => shadowComparisons.push(comparison),
    }).listSessions({ limit: Number.MAX_SAFE_INTEGER, offset: 0 })
    const shadowTranscriptBodyOpens =
      options.readTranscriptBodyOpenCount() - shadowTranscriptOpensBefore
    const mismatchCount = shadowComparisons.filter(
      comparison => !comparison.matched,
    ).length
    const differenceCount = shadowComparisons.reduce(
      (total, comparison) => total + comparison.differenceCount,
      0,
    )
    if (transcriptBodyOpens !== 0 || shadowTranscriptBodyOpens <= 0) {
      throw new Error(`acceptance transcript observer was invalid: ${JSON.stringify({
        indexedTranscriptBodyOpens: transcriptBodyOpens,
        shadowTranscriptBodyOpens,
      })}`)
    }

    return {
      schemaVersion: 1,
      fixture: {
        sessions: options.sessions,
        pageSize,
        corpusFingerprint: expectedFingerprint,
      },
      sourceIntegrity: {
        unchangedAfterBackfill,
        changedSourceCountAfterAppend: changedCorpusSources.length,
        unrelatedSourcesUnchangedAfterAppend,
      },
      scheduling: coordinator.getSchedulingMetrics(),
      queries: {
        page1: {
          offset: 0,
          rowCount: page1.sessions.length,
          statementCount: page1Sql.length,
        },
        page100: {
          offset: page100Offset,
          rowCount: page100.sessions.length,
          statementCount: page100Sql.length,
        },
        globalPlan,
        projectPlan,
      },
      indexedSessionList: {
        total: indexedResult.total,
        rowCount: indexedResult.sessions.length,
        transcriptBodyOpens,
      },
      componentAppend: {
        action: appendResult.kind === 'indexed' ? appendResult.action : appendResult.kind,
        changedSourceRows,
        changedSessionRows,
        messageCountDelta,
      },
      shadow: {
        comparisonCount: shadowComparisons.length,
        mismatchCount,
        differenceCount,
        transcriptBodyOpens: shadowTranscriptBodyOpens,
      },
      productAppend: {
        measured: false,
        reason: 'LOCAL_INDEX_RECONCILIATION_NOT_ACCEPTED',
      },
    }
  } finally {
    let cleanupError: unknown
    try {
      await coordinator?.stop()
    } catch (error) {
      cleanupError = error
    }
    try {
      await Promise.all([
        rm(databasePath, { force: true }),
        rm(`${databasePath}-wal`, { force: true }),
        rm(`${databasePath}-shm`, { force: true }),
      ])
      await rm(rootDir, { recursive: true, force: true })
    } catch (error) {
      cleanupError ??= error
    }
    restoreEnvironment('HOME', originalHome)
    restoreEnvironment('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnvironment('CC_HAHA_LOCAL_INDEX', originalLocalIndexMode)
    if (cleanupError) throw cleanupError
  }
}

export async function runBenchmark(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies = {},
) {
  if (options.mode === 'shadow' && options.scenario !== 'baseline') {
    throw new Error('shadow benchmark only supports the baseline scenario')
  }
  if (options.mode === 'sqlite' && options.scenario !== 'baseline') {
    throw new Error(
      'sqlite product append benchmark requires reconciliation and is not available',
    )
  }

  const rootDir = await mkdtemp(join(tmpdir(), 'cc-haha-local-index-benchmark-'))
  const homeDir = join(rootDir, 'home')
  const configDir = join(homeDir, '.claude')
  const databasePath = join(configDir, 'cc-haha', 'db', 'index-v1.sqlite')
  const originalHome = process.env.HOME
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalLocalIndexMode = process.env.CC_HAHA_LOCAL_INDEX
  const originalLocalAccessToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  let coordinator: LocalIndexCoordinator | undefined
  let report: Record<string, unknown> | undefined

  try {
    await mkdir(homeDir, { recursive: true })
    process.env.HOME = homeDir
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CC_HAHA_LOCAL_INDEX = options.mode === 'file'
      ? 'off'
      : options.mode === 'shadow'
        ? 'shadow'
        : 'on'
    const localAccessToken = createHash('sha256')
      .update(`${rootDir}\0${options.seed}\0local-access`)
      .digest('base64url')
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = localAccessToken

    const corpus = await createLocalIndexCorpus({
      rootDir,
      sessions: options.sessions,
      entriesPerSession: options.entriesPerSession,
      largeTranscriptBytes: options.largeTranscriptBytes,
      seed: options.seed,
    })
    const manifest = JSON.parse(
      await readFile(corpus.manifestPath, 'utf8'),
    ) as CorpusManifest

    if (options.scenario === 'append') {
      report = await runAppendScenario(options, {
        rootDir,
        manifest,
        manifestPath: corpus.manifestPath,
        configDir: corpus.configDir,
      })
      return report
    }

    if (options.mode === 'sqlite') {
      report = await runSqliteProductBenchmark(options, {
        rootDir,
        configDir: corpus.configDir,
        manifestPath: corpus.manifestPath,
        manifest,
        localAccessToken,
      }, dependencies)
      return report
    }

    let readyStatus: LocalIndexStatus | undefined
    let readyDurationMs: number | undefined
    if (options.mode !== 'file') {
      const coordinatorModule = await import(
        '../../src/server/services/localIndex/coordinator.js'
      )
      coordinator = coordinatorModule.localIndexCoordinator
      const readyStartedAt = Bun.nanoseconds()
      await coordinator.start()
      readyStatus = await waitForIndexReady(coordinator, options.timeoutMs)
      readyDurationMs = (Bun.nanoseconds() - readyStartedAt) / 1_000_000
      const expectedSources = manifest.expected.summaries.length
      if (
        readyStatus.discovered !== expectedSources ||
        readyStatus.indexed !== expectedSources ||
        readyStatus.degradedSources !== 0
      ) {
        throw new Error(
          `${options.mode} backfill did not index the complete corpus: ${JSON.stringify({
            expectedSources,
            discovered: readyStatus.discovered,
            indexed: readyStatus.indexed,
            degradedSources: readyStatus.degradedSources,
          })}`,
        )
      }
    }

    const { SessionService } = await import('../../src/server/services/sessionService.js')
    const shadowComparisons: SessionListShadowComparison[] = []
    const execute = async (): Promise<SessionListResult> => {
      const service = options.mode !== 'file'
        ? new SessionService(coordinator!, {
            shadowComparisonMinIntervalMs: 0,
            recordShadowComparison: comparison => {
              shadowComparisons.push(comparison)
            },
          })
        : new SessionService()
      return service.listSessions({ limit: options.sidebarLimit })
    }

    const executeDeadlineSample = (
      phase: BenchmarkSampleContext['phase'],
      index: number,
    ): Promise<SessionListResult> => runWithSampleDeadline({
      execute: () => dependencies.executeSessionList
        ? dependencies.executeSessionList(execute, { phase, index, rootDir })
        : execute(),
      timeoutMs: options.timeoutMs,
      phase,
      index,
    })

    for (let index = 0; index < options.warmupRuns; index += 1) {
      await executeDeadlineSample('warmup', index)
    }

    const samples: number[] = []
    const cpuStart = process.cpuUsage()
    const rssStart = process.memoryUsage().rss
    let lastResult: SessionListResult | undefined
    for (let index = 0; index < options.runs; index += 1) {
      const startedAt = Bun.nanoseconds()
      lastResult = await executeDeadlineSample('measured', index)
      const durationMs = (Bun.nanoseconds() - startedAt) / 1_000_000
      samples.push(durationMs)
    }
    const cpu = process.cpuUsage(cpuStart)
    const rssDeltaBytes = process.memoryUsage().rss - rssStart
    const fileValidation = validateResult(
      lastResult!,
      manifest,
      options.sidebarLimit,
    )
    if (
      fileValidation.actualSessions !== fileValidation.expectedSessions ||
      !fileValidation.orderMatches ||
      !fileValidation.summariesMatch
    ) {
      throw new Error(`file baseline did not match the corpus manifest: ${JSON.stringify(fileValidation)}`)
    }

    const comparisonCount = shadowComparisons.length
    const mismatchCount = shadowComparisons.filter(comparison => !comparison.matched).length
    const differenceCount = shadowComparisons.reduce(
      (total, comparison) => total + comparison.differenceCount,
      0,
    )
    if (options.mode === 'shadow') {
      const expectedComparisons = options.warmupRuns + options.runs
      if (comparisonCount !== expectedComparisons) {
        throw new Error(
          `shadow benchmark expected ${expectedComparisons} comparisons, received ${comparisonCount}`,
        )
      }
      if (mismatchCount > 0 || differenceCount > 0) {
        throw new Error(
          `shadow benchmark detected normalized mismatches: ${JSON.stringify({
            comparisonCount,
            mismatchCount,
            differenceCount,
          })}`,
        )
      }
    }

    const median = percentile(samples, 0.5)
    const p95 = percentile(samples, 0.95)
    const max = Math.max(...samples)
    report = {
      schemaVersion: 1,
      mode: options.mode,
      scenario: options.scenario,
      fixture: {
        rootDir,
        configDir: corpus.configDir,
        manifestPath: corpus.manifestPath,
        seed: options.seed,
        sessions: options.sessions,
        entriesPerSession: options.entriesPerSession,
        largeTranscriptBytes: options.largeTranscriptBytes,
        sidebarLimit: options.sidebarLimit,
        corpusFingerprint: corpusFingerprint(manifest),
        kept: options.keep,
      },
      measurement: {
        operation: 'session-service-list',
        warmupRuns: options.warmupRuns,
        runs: options.runs,
        durationMs: {
          median: roundedMilliseconds(median),
          p95: roundedMilliseconds(p95),
          max: roundedMilliseconds(max),
        },
        timeoutMs: options.timeoutMs,
        timeoutCount: 0,
        cpuMs: {
          user: roundedMilliseconds(cpu.user / 1000),
          system: roundedMilliseconds(cpu.system / 1000),
          total: roundedMilliseconds((cpu.user + cpu.system) / 1000),
        },
        rssDeltaBytes,
        io: {
          instrumented: false,
          filesOpened: null,
          bytesRead: null,
        },
        productAppend: {
          measured: false,
          reason: 'LOCAL_INDEX_RECONCILIATION_NOT_ACCEPTED',
        },
        referenceHardware: {
          measured: false,
          reason: 'REFERENCE_HARDWARE_NOT_RUN',
        },
        sidebarApi: {
          measured: false,
          reason: 'HTTP_API_HARNESS_NOT_RUN',
        },
        firstUsefulContent: {
          measured: false,
          reason: 'STARTUP_INTERACTION_HARNESS_NOT_RUN',
        },
        foregroundDuringBackfill: {
          measured: false,
          reason: 'CONCURRENT_BACKFILL_HARNESS_NOT_RUN',
        },
        eventLoopDelay: {
          measured: false,
          reason: 'EVENT_LOOP_MONITOR_NOT_RUN',
        },
        peakRss: {
          measured: false,
          reason: 'PEAK_RSS_SAMPLER_NOT_RUN',
        },
      },
      ...(options.mode !== 'file'
        ? {
            index: {
              readyDurationMs: roundedMilliseconds(readyDurationMs!),
              status: readyStatus,
              scheduling: coordinator!.getSchedulingMetrics(),
            },
          }
        : {}),
      validation: {
        ...fileValidation,
        ...(options.mode === 'shadow'
          ? { comparisonCount, mismatchCount, differenceCount }
          : {}),
      },
    }
  } finally {
    let cleanupError: unknown
    try {
      await coordinator?.stop()
    } catch (error) {
      cleanupError = error
    }
    if (!options.keep) {
      try {
        await Promise.all([
          rm(databasePath, { force: true }),
          rm(`${databasePath}-wal`, { force: true }),
          rm(`${databasePath}-shm`, { force: true }),
        ])
        await rm(rootDir, { recursive: true, force: true })
      } catch (error) {
        cleanupError ??= error
      }
    }
    restoreEnvironment('HOME', originalHome)
    restoreEnvironment('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnvironment('CC_HAHA_LOCAL_INDEX', originalLocalIndexMode)
    restoreEnvironment('CC_HAHA_LOCAL_ACCESS_TOKEN', originalLocalAccessToken)
    if (cleanupError) throw cleanupError
  }

  return report!
}

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2))
  const report = await runBenchmark(options)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
