import { afterEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openSearchContentDatabase } from './searchContentDatabase.js'
import { createSearchContentIndex } from './searchContentIndex.js'
import {
  createSearchContentProjector,
  extractSearchableSegments,
} from './searchContentProjector.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path =>
    rm(path, { recursive: true, force: true }),
  ))
})

function line(value: Record<string, unknown> | string): string {
  return `${typeof value === 'string' ? value : JSON.stringify(value)}\n`
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-projector-'))
  tempDirs.push(root)
  const sourcePath = join(root, 'projects', '-repo', 'session', 'subagents', 'agent-a.jsonl')
  await mkdir(dirname(sourcePath), { recursive: true })
  const database = openSearchContentDatabase({ path: join(root, 'search.sqlite') })
  const index = createSearchContentIndex(database, { scope: join(root, 'projects') })
  const projector = createSearchContentProjector({ database, index })
  const candidate = {
    path: sourcePath,
    projectPath: '-repo',
    ownerSessionId: 'session',
    ownerTranscriptPath: join(root, 'projects', '-repo', 'session.jsonl'),
    modifiedAtMs: 100,
  }
  return { database, index, projector, candidate, sourcePath }
}

describe('extractSearchableSegments', () => {
  it('matches the visible SearchService user/assistant semantics', () => {
    expect(extractSearchableSegments({
      type: 'user',
      message: { role: 'user', content: '  visible user  ' },
    })).toEqual([{ role: 'user', text: 'visible user' }])
    expect(extractSearchableSegments({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: ' visible assistant ' },
          { type: 'tool_use', name: 'Bash', input: { command: 'secret needle' } },
        ],
      },
    })).toEqual([{ role: 'assistant', text: 'visible assistant' }])
    expect(extractSearchableSegments({
      type: 'user',
      message: {
        role: 'user',
        content: '<command-name>deploy</command-name><command-args>prod</command-args>',
      },
    })).toEqual([{ role: 'user', text: '/deploy prod' }])
    expect(extractSearchableSegments({
      type: 'user',
      message: {
        role: 'user',
        content: '<command-name>deploy</command-name> visible mixed breadcrumb',
      },
    })).toEqual([])
    expect(extractSearchableSegments({
      type: 'progress',
      message: { role: 'user', content: 'not visible' },
    })).toEqual([])
  })
})

describe('search content projector', () => {
  it('indexes complete visible segments recursively and leaves an incomplete tail pending', async () => {
    const { database, index, projector, candidate, sourcePath } = await setup()
    try {
      await writeFile(sourcePath, [
        line({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'nested visible needle' },
        }),
        line({
          type: 'assistant',
          uuid: 'a1',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'assistant searchable block' },
              { type: 'tool_use', input: { command: 'tool secret' } },
            ],
          },
        }),
        line('{malformed}'),
        '{"type":"user","message":{"role":"user","content":"pending',
      ].join(''))

      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'full',
        state: 'pending',
        indexedLines: 3,
        documentCount: 2,
      })
      expect(index.getSource(sourcePath)).toMatchObject({
        ownerSessionId: 'session',
        ownerTranscriptPath: candidate.ownerTranscriptPath,
        state: 'pending',
        indexedLines: 3,
      })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('nested visible')?.sessions).toEqual([])
      expect(index.query('assistant searchable')?.sessions).toEqual([])
      expect(index.query('tool secret')?.sessions).toEqual([])
      expect(index.query('pending')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })

  it('rebuilds pending sources from byte zero, appends ready tails, and cascades deletes', async () => {
    const { database, index, projector, candidate, sourcePath } = await setup()
    try {
      await writeFile(
        sourcePath,
        `${line({
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'old stable body' },
        })}{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":"append`,
      )
      expect(await projector.projectSource(candidate)).toMatchObject({
        action: 'full',
        state: 'pending',
      })
      await appendFile(sourcePath, ' complete body"}}\n')

      expect(await projector.projectSource({
        ...candidate,
        modifiedAtMs: 200,
      })).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        state: 'ready',
        indexedLines: 2,
        documentCount: 2,
      })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('old stable')?.sessions[0]?.matchCount).toBe(1)
      expect(index.query('append complete')?.sessions[0]?.matches[0]).toMatchObject({
        lineNumber: 2,
        role: 'assistant',
      })
      expect(index.query('append complete')?.sessions[0]?.matchCount).toBe(1)

      await appendFile(sourcePath, line({
        type: 'user',
        uuid: 'u2',
        message: { role: 'user', content: 'ready append body' },
      }))
      expect(await projector.projectSource({
        ...candidate,
        modifiedAtMs: 250,
      })).toMatchObject({
        kind: 'indexed',
        action: 'append',
        state: 'ready',
        indexedLines: 3,
        documentCount: 1,
      })
      expect(index.query('old stable')?.sessions[0]?.matchCount).toBe(1)
      expect(index.query('ready append')?.sessions[0]?.matchCount).toBe(1)

      await writeFile(sourcePath, line({
        type: 'user',
        uuid: 'u3',
        message: { role: 'user', content: 'replacement only body' },
      }))
      expect(await projector.projectSource({
        ...candidate,
        modifiedAtMs: 300,
      })).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        indexedLines: 1,
      })
      expect(index.query('old stable')?.sessions).toEqual([])
      expect(index.query('append complete')?.sessions).toEqual([])
      expect(index.query('ready append')?.sessions).toEqual([])
      expect(index.query('replacement only')?.sessions).toHaveLength(1)

      await rm(sourcePath)
      expect(await projector.projectSource(candidate)).toEqual({ kind: 'deleted' })
      expect(index.getSource(sourcePath)).toBeNull()
      expect(index.query('replacement only')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })

  it('returns unchanged without replacing documents when the fingerprint is stable', async () => {
    const { database, index, projector, candidate, sourcePath } = await setup()
    try {
      await writeFile(sourcePath, line({
        type: 'user',
        message: { role: 'user', content: 'stable body' },
      }))
      await projector.projectSource(candidate)
      expect(await projector.projectSource({
        ...candidate,
        modifiedAtMs: 999,
      })).toMatchObject({
        kind: 'indexed',
        action: 'unchanged',
        documentCount: 0,
      })
      expect(index.getSource(sourcePath)?.modifiedAtMs).toBe(999)
    } finally {
      database.close()
    }
  })

  it('bounds a JSONL line without a newline and degrades at the last safe boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-projector-bounded-'))
    tempDirs.push(root)
    const sourcePath = join(root, 'projects', '-repo', 'oversized.jsonl')
    await mkdir(dirname(sourcePath), { recursive: true })
    const database = openSearchContentDatabase({ path: join(root, 'search.sqlite') })
    const index = createSearchContentIndex(database, { scope: join(root, 'projects') })
    const projector = createSearchContentProjector({
      database,
      index,
      maxJsonlLineBytes: 128,
    })
    const firstLine = line({
      type: 'user',
      message: { role: 'user', content: 'safe searchable body' },
    })
    await writeFile(sourcePath, `${firstLine}${'x'.repeat(4096)}`)
    const candidate = {
      path: sourcePath,
      projectPath: '-repo',
      ownerSessionId: 'oversized',
      ownerTranscriptPath: sourcePath,
      modifiedAtMs: 100,
    }

    try {
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        action: 'full',
        state: 'degraded',
        indexedBytes: Buffer.byteLength(firstLine),
        indexedLines: 1,
        documentCount: 1,
      })
      expect(index.getSource(sourcePath)).toMatchObject({
        state: 'degraded',
        indexedBytes: Buffer.byteLength(firstLine),
        lastErrorCode: 'SEARCH_CONTENT_JSONL_LINE_TOO_LARGE',
      })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('safe searchable')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })

  it('commits projection batches with budget callbacks and leaves interrupted writes pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-projector-batches-'))
    tempDirs.push(root)
    const sourcePath = join(root, 'projects', '-repo', 'batched.jsonl')
    await mkdir(dirname(sourcePath), { recursive: true })
    const database = openSearchContentDatabase({ path: join(root, 'search.sqlite') })
    const index = createSearchContentIndex(database, { scope: join(root, 'projects') })
    let checkpoints = 0
    ;(database as typeof database & {
      checkpointTruncate: () => { busy: number; logFrames: number; checkpointedFrames: number }
    }).checkpointTruncate = () => {
      checkpoints += 1
      return { busy: 0, logFrames: 0, checkpointedFrames: 0 }
    }
    let callbacks = 0
    let yields = 0
    const projector = createSearchContentProjector({
      database,
      index,
      batchDocumentLimit: 1,
      onBatchCommitted: () => {
        callbacks += 1
        return callbacks < 3
      },
      yieldToForeground: async () => {
        yields += 1
      },
    })
    await writeFile(sourcePath, [0, 1, 2].map(offset => line({
      type: 'user',
      message: { role: 'user', content: `budget needle ${offset}` },
    })).join(''))
    const candidate = {
      path: sourcePath,
      projectPath: '-repo',
      ownerSessionId: 'batched',
      ownerTranscriptPath: sourcePath,
      modifiedAtMs: 100,
    }

    try {
      expect(await projector.projectSource(candidate)).toEqual({
        kind: 'retry',
        reason: 'storage-limit',
      })
      expect(callbacks).toBe(3)
      expect(yields).toBe(3)
      expect(checkpoints).toBe(3)
      expect(index.getSource(sourcePath)?.state).toBe('pending')
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('budget needle')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })

  it('serves HTTP while a large projection is paused between committed batches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-projector-responsive-'))
    tempDirs.push(root)
    const sourcePath = join(root, 'projects', '-repo', 'responsive.jsonl')
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, Array.from({ length: 100 }, (_, offset) => line({
      type: 'user',
      message: { role: 'user', content: `responsive needle ${offset}` },
    })).join(''))
    const database = openSearchContentDatabase({ path: join(root, 'search.sqlite') })
    const index = createSearchContentIndex(database, { scope: join(root, 'projects') })
    let enteredYield!: () => void
    const yieldEntered = new Promise<void>(resolve => {
      enteredYield = resolve
    })
    let releaseYield!: () => void
    const yieldGate = new Promise<void>(resolve => {
      releaseYield = resolve
    })
    let firstYield = true
    const projector = createSearchContentProjector({
      database,
      index,
      batchDocumentLimit: 1,
      yieldToForeground: async () => {
        if (!firstYield) return
        firstYield = false
        enteredYield()
        await yieldGate
      },
    })
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('healthy'),
    })
    let projectionSettled = false
    const projection = projector.projectSource({
      path: sourcePath,
      projectPath: '-repo',
      ownerSessionId: 'responsive',
      ownerTranscriptPath: sourcePath,
      modifiedAtMs: 100,
    }).finally(() => {
      projectionSettled = true
    })

    try {
      await yieldEntered
      const response = await fetch(new URL('/health', server.url))
      expect(await response.text()).toBe('healthy')
      expect(projectionSettled).toBe(false)
      releaseYield()
      expect(await projection).toMatchObject({
        kind: 'indexed',
        state: 'ready',
        documentCount: 100,
      })
    } finally {
      releaseYield()
      await projection.catch(() => undefined)
      server.stop(true)
      database.close()
    }
  })

  it('rebuilds after an interrupted append without duplicating documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-projector-interrupted-append-'))
    tempDirs.push(root)
    const sourcePath = join(root, 'projects', '-repo', 'interrupted-append.jsonl')
    await mkdir(dirname(sourcePath), { recursive: true })
    const database = openSearchContentDatabase({ path: join(root, 'search.sqlite') })
    const index = createSearchContentIndex(database, { scope: join(root, 'projects') })
    const candidate = {
      path: sourcePath,
      projectPath: '-repo',
      ownerSessionId: 'interrupted-append',
      ownerTranscriptPath: sourcePath,
      modifiedAtMs: 100,
    }

    try {
      await writeFile(sourcePath, line({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'stable before append' },
      }))
      const initialProjector = createSearchContentProjector({ database, index })
      expect(await initialProjector.projectSource(candidate)).toMatchObject({
        action: 'full',
        state: 'ready',
        documentCount: 1,
      })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('stable before append')?.sessions[0]?.matchCount).toBe(1)

      await appendFile(sourcePath, line({
        type: 'assistant',
        uuid: 'a1',
        message: { role: 'assistant', content: 'interrupted append body' },
      }))
      let callbacks = 0
      const interruptedProjector = createSearchContentProjector({
        database,
        index,
        batchDocumentLimit: 1,
        onBatchCommitted: () => {
          callbacks += 1
          return callbacks < 2
        },
      })
      expect(await interruptedProjector.projectSource({
        ...candidate,
        modifiedAtMs: 200,
      })).toEqual({ kind: 'retry', reason: 'storage-limit' })
      expect(index.getSource(sourcePath)?.state).toBe('pending')
      expect(index.query('stable before append')?.sessions).toEqual([])
      expect(index.query('interrupted append')?.sessions).toEqual([])

      const recoveryProjector = createSearchContentProjector({
        database,
        index,
        batchDocumentLimit: 1,
      })
      expect(await recoveryProjector.projectSource({
        ...candidate,
        modifiedAtMs: 300,
      })).toMatchObject({
        kind: 'indexed',
        action: 'rebuild',
        state: 'ready',
        documentCount: 2,
        indexedLines: 2,
      })
      expect(index.query('stable before append')?.sessions[0]?.matchCount).toBe(1)
      expect(index.query('interrupted append')?.sessions[0]?.matchCount).toBe(1)
    } finally {
      database.close()
    }
  })

  it('shares an in-flight delete and allows a fresh delete after it settles', async () => {
    const { database, index, candidate, sourcePath } = await setup()
    await writeFile(sourcePath, [0, 1].map(offset => line({
      type: 'user',
      message: { role: 'user', content: `shared delete ${offset}` },
    })).join(''))
    const initialProjector = createSearchContentProjector({ database, index })
    await initialProjector.projectSource(candidate)

    let enteredYield!: () => void
    const yieldEntered = new Promise<void>(resolve => {
      enteredYield = resolve
    })
    let releaseYield!: () => void
    const yieldGate = new Promise<void>(resolve => {
      releaseYield = resolve
    })
    let firstYield = true
    let deleteBatches = 0
    const projector = createSearchContentProjector({
      database,
      index,
      batchDocumentLimit: 1,
      onBatchCommitted: () => {
        deleteBatches += 1
        return true
      },
      yieldToForeground: async () => {
        if (!firstYield) return
        firstYield = false
        enteredYield()
        await yieldGate
      },
    })

    const firstDelete = projector.deleteSource(sourcePath)
    try {
      await yieldEntered
      const secondDelete = projector.deleteSource(sourcePath)
      releaseYield()

      expect(await Promise.all([firstDelete, secondDelete])).toEqual([
        { kind: 'deleted' },
        { kind: 'deleted' },
      ])
      expect(deleteBatches).toBe(4)

      expect(await projector.deleteSource(sourcePath)).toEqual({ kind: 'deleted' })
      expect(deleteBatches).toBe(4)
    } finally {
      releaseYield()
      await Promise.resolve(firstDelete).catch(() => undefined)
      database.close()
    }
  })

  it('deletes sources through projector batches with foreground yields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-search-projector-delete-batches-'))
    tempDirs.push(root)
    const sourcePath = join(root, 'projects', '-repo', 'delete-batched.jsonl')
    await mkdir(dirname(sourcePath), { recursive: true })
    const database = openSearchContentDatabase({ path: join(root, 'search.sqlite') })
    const index = createSearchContentIndex(database, { scope: join(root, 'projects') })
    await writeFile(sourcePath, [0, 1, 2].map(offset => line({
      type: 'user',
      message: { role: 'user', content: `delete needle ${offset}` },
    })).join(''))
    const candidate = {
      path: sourcePath,
      projectPath: '-repo',
      ownerSessionId: 'delete-batched',
      ownerTranscriptPath: sourcePath,
      modifiedAtMs: 100,
    }
    let callbacks = 0
    let yields = 0
    const projector = createSearchContentProjector({
      database,
      index,
      batchDocumentLimit: 1,
      onBatchCommitted: () => {
        callbacks += 1
        return true
      },
      yieldToForeground: async () => {
        yields += 1
      },
    })

    try {
      expect(await projector.projectSource(candidate)).toMatchObject({
        kind: 'indexed',
        state: 'ready',
      })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('delete needle')?.sessions[0]?.matchCount).toBe(3)
      callbacks = 0
      yields = 0

      const deleteOperation = projector.deleteSource(sourcePath)
      expect(deleteOperation.kind).toBe('deleted')
      expect(await deleteOperation).toEqual({ kind: 'deleted' })
      expect(index.getSource(sourcePath)).toBeNull()
      expect(callbacks).toBeGreaterThan(1)
      expect(yields).toBe(callbacks)
      expect(index.query('delete needle')?.sessions).toEqual([])
    } finally {
      database.close()
    }
  })
})
