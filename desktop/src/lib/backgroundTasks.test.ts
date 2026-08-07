import { describe, expect, it } from 'vitest'
import type { BackgroundAgentTask } from '../types/chat'
import {
  formatDurationMs,
  formatDurationSeconds,
  hasRunningBackgroundTasks,
  hasRunningSubagentTasks,
} from './backgroundTasks'
import { translate } from '../i18n'

function task(
  taskId: string,
  overrides: Partial<BackgroundAgentTask> = {},
): BackgroundAgentTask {
  return {
    taskId,
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('hasRunningBackgroundTasks', () => {
  it('does not treat AutoDream as foreground session activity', () => {
    expect(hasRunningBackgroundTasks({
      dream: task('dream', { taskType: 'dream' }),
    })).toBe(false)
  })

  it('still reports user-started background tasks as running', () => {
    expect(hasRunningBackgroundTasks({
      shell: task('shell', { taskType: 'local_bash' }),
      dream: task('dream', { taskType: 'dream' }),
    })).toBe(true)
  })
})

describe('hasRunningSubagentTasks', () => {
  it.each(['local_agent', 'remote_agent'])('reports a running %s as stoppable', (taskType) => {
    expect(hasRunningSubagentTasks({
      agent: task('agent', { taskType }),
    })).toBe(true)
  })

  it.each(['local_bash', 'dream', undefined])('does not treat %s as a stoppable SubAgent', (taskType) => {
    expect(hasRunningSubagentTasks({
      task: task('task', { taskType }),
    })).toBe(false)
  })

  it('ignores an Agent that already reached a terminal status', () => {
    expect(hasRunningSubagentTasks({
      agent: task('agent', { taskType: 'local_agent', status: 'stopped' }),
    })).toBe(false)
  })
})

describe('formatDurationSeconds', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('en', key, params)

  it.each([
    [0, '0s'],
    [45, '45s'],
    [59.4, '59s'],
    [60, '1m 0s'],
    [739, '12m 19s'],
  ])('writes %ss as %s', (seconds, expected) => {
    expect(formatDurationSeconds(seconds, t)).toBe(expected)
  })

  it('carries into hours instead of printing three-digit minutes', () => {
    expect(formatDurationSeconds(75 * 60 + 30, t)).toBe('1h 15m')
    expect(formatDurationSeconds(2 * 3600, t)).toBe('2h 0m')
  })

  it('respects the minimum floor used by still-running tasks', () => {
    expect(formatDurationSeconds(0.2, t, 1)).toBe('1s')
  })
})

describe('formatDurationMs', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate('en', key, params)

  it('returns null for a missing or negative duration', () => {
    expect(formatDurationMs(undefined, t)).toBeNull()
    expect(formatDurationMs(-1, t)).toBeNull()
  })

  it('rounds milliseconds to whole seconds', () => {
    expect(formatDurationMs(739_000, t)).toBe('12m 19s')
  })
})
