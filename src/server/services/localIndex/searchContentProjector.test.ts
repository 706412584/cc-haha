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

  it('atomically appends a completed tail, rebuilds rewrites, and cascades deletes', async () => {
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
        action: 'append',
        state: 'ready',
        indexedLines: 2,
        documentCount: 1,
      })
      index.setReadiness({ state: 'ready', discovered: 1, indexed: 1 })
      expect(index.query('append complete')?.sessions[0]?.matches[0]).toMatchObject({
        lineNumber: 2,
        role: 'assistant',
      })

      await writeFile(sourcePath, line({
        type: 'user',
        uuid: 'u2',
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
})
