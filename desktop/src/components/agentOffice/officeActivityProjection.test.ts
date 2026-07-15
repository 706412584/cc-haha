import { describe, expect, it } from 'vitest'
import type { ActivityRow } from '../activity/sessionActivityModel'
import { projectOfficeActivity } from './officeActivityProjection'

function row(overrides: Partial<ActivityRow>): ActivityRow {
  return {
    id: 'row-1',
    section: 'tasks',
    label: 'Current task',
    status: 'in_progress',
    openable: false,
    ...overrides,
  }
}

describe('projectOfficeActivity', () => {
  it('keeps historical task summaries out of the live task flow and active counts', () => {
    const projection = projectOfficeActivity([
      row({ id: 'history', label: 'Earlier tasks', taskHistory: { completed: 1, total: 2, turnCount: 1 } }),
      row({ id: 'current' }),
    ], 10_000)

    expect(projection.liveRows.map((item) => item.id)).toEqual(['current'])
    expect(projection.activeRows.map((item) => item.id)).toEqual(['current'])
  })

  it('keeps idle team members visible without counting them as active work', () => {
    const idleMember = row({ id: 'designer', section: 'team', label: 'Designer', status: 'idle' })

    expect(projectOfficeActivity([idleMember])).toMatchObject({
      liveRows: [idleMember],
      activeRows: [],
    })
  })

  it('expires finished failures after the attention window while preserving undated failures', () => {
    const now = 1_000_000
    const projection = projectOfficeActivity([
      row({ id: 'recent', section: 'backgroundTasks', status: 'failed', updatedAt: now - 30_000 }),
      row({ id: 'stale', section: 'backgroundTasks', status: 'failed', updatedAt: now - 10 * 60_000 }),
      row({ id: 'undated', section: 'subagents', status: 'error', updatedAt: undefined }),
    ], now)

    expect(projection.liveRows.map((item) => item.id)).toEqual(['recent', 'undated'])
    expect(projection.failedRows.map((item) => item.id)).toEqual(['recent', 'undated'])
  })

  it('uses a readable background command title instead of an opaque task id', () => {
    const projection = projectOfficeActivity([
      row({
        id: 'bmn3icgpx',
        section: 'backgroundTasks',
        status: 'failed',
        label: 'bmn3icgpx',
        description: 'Background command "启动 Vite 模式 Electron" failed with exit code 127',
        updatedAt: 10_000,
      }),
    ], 10_000)

    expect(projection.liveRows[0]).toMatchObject({
      label: '启动 Vite 模式 Electron',
      description: 'Background command "启动 Vite 模式 Electron" failed with exit code 127',
    })
  })
})
