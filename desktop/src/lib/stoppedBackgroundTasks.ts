export type StoppedBackgroundTaskRecord = {
  taskId: string
  stoppedAt: number
}

const STORAGE_KEY = 'cc-haha-stopped-background-tasks'
const MAX_RECORDS_PER_SESSION = 50

type StoppedTaskBucket = Record<string, StoppedBackgroundTaskRecord[]>

function isStoppedTaskRecord(value: unknown): value is StoppedBackgroundTaskRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as StoppedBackgroundTaskRecord).taskId === 'string' &&
    Number.isFinite((value as StoppedBackgroundTaskRecord).stoppedAt)
  )
}

function readBucket(): StoppedTaskBucket {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as StoppedTaskBucket
  } catch {
    return {}
  }
}

function writeBucket(bucket: StoppedTaskBucket): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bucket))
}

export function readStoppedBackgroundTasks(sessionId: string): StoppedBackgroundTaskRecord[] {
  const records = readBucket()[sessionId]
  return Array.isArray(records) ? records.filter(isStoppedTaskRecord) : []
}

// The server confirmed this task stopped — remember it so a session restore
// can re-apply the terminal state even when the transcript has no terminal
// notification for it (CLI died before writing one).
export function recordStoppedBackgroundTask(sessionId: string, taskId: string, stoppedAt: number): void {
  const bucket = readBucket()
  const records = (Array.isArray(bucket[sessionId]) ? bucket[sessionId] : []).filter(
    (record) => record.taskId !== taskId,
  )
  records.push({ taskId, stoppedAt })
  while (records.length > MAX_RECORDS_PER_SESSION) {
    let oldestIndex = 0
    for (let i = 1; i < records.length; i++) {
      if (records[i]!.stoppedAt < records[oldestIndex]!.stoppedAt) oldestIndex = i
    }
    records.splice(oldestIndex, 1)
  }
  bucket[sessionId] = records
  writeBucket(bucket)
}
