import { appendFile, mkdir, readFile } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from '../debug.js'
import { getWorkflowJournalPath } from './paths.js'

/**
 * One line per agent lifecycle transition, appended as the run progresses.
 *
 * `started` is written before the subagent is spawned and `result` after it
 * returns. Resume needs both: an agent that has a `started` line but no
 * `result` was in flight when the run stopped, which is what makes every agent
 * after it re-run instead of replaying.
 */
export type WorkflowJournalEntry =
  | { type: 'started'; key: string; agentId: string }
  | { type: 'result'; key: string; agentId: string; result: unknown }

export type WorkflowJournalSnapshot = {
  /** key → the cached return value of a completed agent. */
  results: Map<string, { agentId: string; result: unknown }>
  /** key → agent ids that started but never produced a result. */
  started: Map<string, string[]>
}

/**
 * Append-only record of a run's agent results, used to replay a resumed run.
 *
 * Writes are serialized through a promise chain: `agent()` calls resolve
 * concurrently, and two overlapping appends to the same file can interleave
 * partial lines.
 */
export class WorkflowJournal {
  private readonly path: string
  private writeChain: Promise<void> = Promise.resolve()
  private dirReady = false

  /** Takes an absolute path so tests never resolve against the real session dir. */
  constructor(path: string) {
    this.path = path
  }

  get filePath(): string {
    return this.path
  }

  /**
   * Wait for every queued append to hit disk.
   *
   * Appends are fired without awaiting so an agent's result reaches the script
   * immediately; the run must flush before it settles or the last result can
   * be missing from a resume.
   */
  async flush(): Promise<void> {
    await this.writeChain
  }

  async append(entry: WorkflowJournalEntry): Promise<void> {
    const line = `${safeStringify(entry)}\n`
    this.writeChain = this.writeChain.then(async () => {
      if (!this.dirReady) {
        await mkdir(dirname(this.path), { recursive: true })
        this.dirReady = true
      }
      await appendFile(this.path, line, 'utf8')
    })
    return this.writeChain
  }

  /**
   * Read back a previous run's journal. A truncated or corrupt trailing line
   * is skipped rather than failing the resume — the worst case is that one
   * agent re-runs.
   */
  async load(): Promise<WorkflowJournalSnapshot> {
    const snapshot: WorkflowJournalSnapshot = {
      results: new Map(),
      started: new Map(),
    }
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      return snapshot
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let entry: WorkflowJournalEntry
      try {
        entry = JSON.parse(line) as WorkflowJournalEntry
      } catch {
        logForDebugging(`workflow journal: skipping malformed line in ${this.path}`)
        continue
      }
      if (entry.type === 'result') {
        snapshot.results.set(entry.key, {
          agentId: entry.agentId,
          result: entry.result,
        })
        snapshot.started.delete(entry.key)
      } else if (entry.type === 'started') {
        if (snapshot.results.has(entry.key)) continue
        const existing = snapshot.started.get(entry.key) ?? []
        existing.push(entry.agentId)
        snapshot.started.set(entry.key, existing)
      }
    }
    return snapshot
  }
}

/** The journal for a run, resolved against the current session's directory. */
export function createRunJournal(runId: string): WorkflowJournal {
  return new WorkflowJournal(getWorkflowJournalPath(runId))
}

/**
 * Cache key for one `agent()` call.
 *
 * Chained through the previous key so position in the call order is part of
 * the identity: two identical `agent('review')` calls in a loop must not share
 * a cache entry, and inserting a call ahead of them must invalidate both.
 */
export function workflowCacheKey(
  prompt: string,
  opts: unknown,
  previousKey: string,
): string {
  return `${previousKey}|${prompt}|${safeStringify(opts ?? null)}`
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  return (
    JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString()
      if (typeof val === 'function') return undefined
      if (val !== null && typeof val === 'object') {
        if (seen.has(val as object)) return '[Circular]'
        seen.add(val as object)
      }
      return val
    }) ?? 'null'
  )
}
