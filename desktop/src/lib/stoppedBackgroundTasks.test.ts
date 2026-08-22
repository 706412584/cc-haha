import { beforeEach, describe, expect, it } from 'vitest'
import { readStoppedBackgroundTasks, recordStoppedBackgroundTask } from './stoppedBackgroundTasks'

const SESSION_ID = 'test-session-1'

describe('stoppedBackgroundTasks persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns an empty list for a session with no records', () => {
    expect(readStoppedBackgroundTasks(SESSION_ID)).toEqual([])
  })

  it('round-trips a recorded stop', () => {
    recordStoppedBackgroundTask(SESSION_ID, 'task-1', 1000)
    expect(readStoppedBackgroundTasks(SESSION_ID)).toEqual([
      { taskId: 'task-1', stoppedAt: 1000 },
    ])
  })

  it('deduplicates by taskId keeping the latest stoppedAt', () => {
    recordStoppedBackgroundTask(SESSION_ID, 'task-1', 1000)
    recordStoppedBackgroundTask(SESSION_ID, 'task-2', 2000)
    recordStoppedBackgroundTask(SESSION_ID, 'task-1', 3000)
    const records = readStoppedBackgroundTasks(SESSION_ID)
    expect(records.filter((r) => r.taskId === 'task-1')).toHaveLength(1)
    expect(records.find((r) => r.taskId === 'task-1')?.stoppedAt).toBe(3000)
    expect(records).toHaveLength(2)
  })

  it('keeps records scoped per session', () => {
    recordStoppedBackgroundTask('session-a', 'task-1', 1000)
    expect(readStoppedBackgroundTasks('session-b')).toEqual([])
  })

  it('caps the bucket at 50 records dropping the oldest', () => {
    for (let i = 0; i < 55; i++) {
      recordStoppedBackgroundTask(SESSION_ID, `task-${i}`, i)
    }
    const records = readStoppedBackgroundTasks(SESSION_ID)
    expect(records).toHaveLength(50)
    // Oldest five (task-0..task-4) were evicted.
    expect(records.some((r) => r.taskId === 'task-0')).toBe(false)
    expect(records.some((r) => r.taskId === 'task-54')).toBe(true)
  })

  it('tolerates corrupt stored JSON', () => {
    localStorage.setItem('cc-haha-stopped-background-tasks', '{not json')
    expect(readStoppedBackgroundTasks(SESSION_ID)).toEqual([])
    // And a write after corruption recovers the key.
    recordStoppedBackgroundTask(SESSION_ID, 'task-1', 1000)
    expect(readStoppedBackgroundTasks(SESSION_ID)).toHaveLength(1)
  })
})
