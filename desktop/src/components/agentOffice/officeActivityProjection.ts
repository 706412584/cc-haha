import type { ActivityRow } from '../activity/sessionActivityModel'

const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'running'])
const FAILED_STATUSES = new Set(['failed', 'error'])
const FAILURE_ATTENTION_WINDOW_MS = 5 * 60_000

function timestampMillis(value: ActivityRow['updatedAt']): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readableBackgroundLabel(row: ActivityRow): string | null {
  if (row.section !== 'backgroundTasks' || row.label !== row.id) return null
  const text = row.description || row.summary || ''
  const quotedCommand = text.match(/Background command [“"](.+?)[”"] failed/i)
  return quotedCommand?.[1]?.trim() || row.workflowName?.trim() || null
}

function presentOfficeRow(row: ActivityRow): ActivityRow {
  const label = readableBackgroundLabel(row)
  return label ? { ...row, label } : row
}

function needsFailureAttention(row: ActivityRow, now: number): boolean {
  if (!FAILED_STATUSES.has(row.status)) return false
  const updatedAt = timestampMillis(row.updatedAt)
  return updatedAt === null || now - updatedAt <= FAILURE_ATTENTION_WINDOW_MS
}

function isLiveOfficeRow(row: ActivityRow, now: number): boolean {
  return ACTIVE_STATUSES.has(row.status) ||
    needsFailureAttention(row, now) ||
    (row.section === 'team' && row.status === 'idle')
}

export type OfficeActivityProjection = {
  liveRows: ActivityRow[]
  activeRows: ActivityRow[]
  failedRows: ActivityRow[]
  completedRows: ActivityRow[]
}

export function projectOfficeActivity(
  rows: ActivityRow[],
  _now = Date.now(),
): OfficeActivityProjection {
  const currentRows = rows.filter((row) => !row.taskHistory).map(presentOfficeRow)
  const failedRows = currentRows.filter((row) => needsFailureAttention(row, _now))
  return {
    liveRows: currentRows.filter((row) => isLiveOfficeRow(row, _now)),
    activeRows: currentRows.filter((row) => ACTIVE_STATUSES.has(row.status)),
    failedRows,
    completedRows: currentRows.filter((row) => row.status === 'completed'),
  }
}
