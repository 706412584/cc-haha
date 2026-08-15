import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod/v4'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import { uniq } from './array.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir, getTeamsDir, isEnvTruthy } from './envUtils.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { lazySchema } from './lazySchema.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { createSignal } from './signal.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { getTeamName } from './teammate.js'
import { getTeammateContext } from './teammateContext.js'

// Listeners for task list updates (used for immediate UI refresh in same process)
const tasksUpdated = createSignal()
type TaskListLifecycleContext = {
  held: ReadonlySet<string>
  lease: { active: boolean }
}
const taskListLifecycleContext = new AsyncLocalStorage<TaskListLifecycleContext>()

function isTaskListLifecycleLockHeld(taskListId: string): boolean {
  const context = taskListLifecycleContext.getStore()
  return context?.lease.active === true &&
    context.held.has(sanitizePathComponent(taskListId))
}

/**
 * Team name set by the leader when creating a team.
 * Used by getTaskListId() so the leader's tasks are stored under the team name
 * (matching where tmux/iTerm2 teammates look), not under the session ID.
 */
let leaderTeamName: string | undefined

/**
 * Sets the leader's team name for task list resolution.
 * Called by TeamCreateTool when a team is created.
 */
export function setLeaderTeamName(teamName: string): void {
  if (leaderTeamName === teamName) return
  leaderTeamName = teamName
  // Changing the task list ID is a "tasks updated" event for subscribers —
  // they're now looking at a different directory.
  notifyTasksUpdated()
}

/**
 * Clears the leader's team name.
 * Called when a team is deleted.
 */
export function clearLeaderTeamName(): void {
  if (leaderTeamName === undefined) return
  leaderTeamName = undefined
  notifyTasksUpdated()
}

/**
 * Register a listener to be called when tasks are updated in this process.
 * Returns an unsubscribe function.
 */
export const onTasksUpdated = tasksUpdated.subscribe

/**
 * Notify listeners that tasks have been updated.
 * Called internally after createTask, updateTask, etc.
 * Wraps emit in try/catch so listener failures never propagate to callers
 * (task mutations must succeed from the caller's perspective).
 */
export function notifyTasksUpdated(): void {
  try {
    tasksUpdated.emit()
  } catch {
    // Ignore listener errors — task mutations must not fail due to notification issues
  }
}

export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export const TaskStatusSchema = lazySchema(() =>
  z.enum(['pending', 'in_progress', 'completed']),
)
export type TaskStatus = z.infer<ReturnType<typeof TaskStatusSchema>>

export const TaskSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    subject: z.string(),
    description: z.string(),
    activeForm: z.string().optional(), // present continuous form for spinner (e.g., "Running tests")
    owner: z.string().optional(), // agent ID
    status: TaskStatusSchema(),
    blocks: z.array(z.string()), // task IDs this task blocks
    blockedBy: z.array(z.string()), // task IDs that block this task
    metadata: z.record(z.string(), z.unknown()).optional(), // arbitrary metadata
  }),
)
export type Task = z.infer<ReturnType<typeof TaskSchema>>

export type TaskListTerminalIdentity = {
  teamName: string
  createdAt: number
  leadSessionId?: string
}

export type TaskListLifecycleToken = {
  generation: number
  identity: TaskListTerminalIdentity
}

export type TaskListTerminalReceipt = TaskListSnapshot & {
  frameId: string
  generation: number
  identity: TaskListTerminalIdentity
}

export type TaskListLifecycleState = {
  schemaVersion: 1
  generation: number
  deleted: boolean
  activeIdentity?: TaskListTerminalIdentity
  terminals: TaskListTerminalReceipt[]
  [key: string]: unknown
}

// High water mark file name - stores the maximum task ID ever assigned
const HIGH_WATER_MARK_FILE = '.highwatermark'
const TASK_LIST_REVISION_FILE = '.revision'
const TASK_LIST_LIFECYCLE_STATE_SCHEMA_VERSION = 1

// Lock options: retry with backoff so concurrent callers (multiple Claudes
// in a swarm) wait for the lock instead of failing immediately. The sync
// lockSync API blocked the event loop; the async API needs explicit retries
// to achieve the same serialization semantics.
//
// Budget sized for ~10+ concurrent swarm agents: each critical section does
// readdir + N×readFile + writeFile (~50-100ms on slow disks), so the last
// caller in a 10-way race needs ~900ms. retries=30 gives ~2.6s total wait.
const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

function getHighWaterMarkPath(taskListId: string): string {
  return join(getTasksDir(taskListId), HIGH_WATER_MARK_FILE)
}

function getTaskListRevisionPath(taskListId: string): string {
  return join(getTasksDir(taskListId), TASK_LIST_REVISION_FILE)
}

async function readTaskListRevisionLocked(taskListId: string): Promise<number> {
  try {
    const content = (await readFile(getTaskListRevisionPath(taskListId), 'utf-8')).trim()
    if (!content) {
      throw new Error(`Invalid empty task-list revision for ${taskListId}`)
    }
    const revision = Number(content)
    if (Number.isSafeInteger(revision) && revision >= 0) return revision
    throw new Error(`Invalid task-list revision for ${taskListId}: ${content}`)
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return 0
    throw error
  }
}

async function bumpTaskListRevisionLocked(taskListId: string): Promise<number> {
  const revision = await readTaskListRevisionLocked(taskListId) + 1
  const revisionPath = getTaskListRevisionPath(taskListId)
  const temporaryPath = `${revisionPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, String(revision))
  await rename(temporaryPath, revisionPath)
  return revision
}

async function readHighWaterMark(taskListId: string): Promise<number> {
  const path = getHighWaterMarkPath(taskListId)
  try {
    const content = (await readFile(path, 'utf-8')).trim()
    const value = parseInt(content, 10)
    return isNaN(value) ? 0 : value
  } catch {
    return 0
  }
}

async function writeHighWaterMark(
  taskListId: string,
  value: number,
): Promise<void> {
  const path = getHighWaterMarkPath(taskListId)
  await writeFile(path, String(value))
}

export function isTodoV2Enabled(): boolean {
  // Force-enable tasks in non-interactive mode (e.g. SDK users who want Task tools over TodoWrite)
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TASKS)) {
    return true
  }
  return !getIsNonInteractiveSession()
}

/**
 * Resets the task list for a new swarm - clears any existing tasks.
 * Writes a high water mark file to prevent ID reuse after reset.
 * Should be called when a new swarm is created to ensure task numbering starts at 1.
 * Uses file locking to prevent race conditions when multiple Claudes run in parallel.
 */
async function resetTaskListUnsafe(taskListId: string): Promise<void> {
  const dir = getTasksDir(taskListId)
  const currentHighest = await findHighestTaskIdFromFiles(taskListId)
  if (currentHighest > 0) {
    const existingMark = await readHighWaterMark(taskListId)
    if (currentHighest > existingMark) {
      await writeHighWaterMark(taskListId, currentHighest)
    }
  }

  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    files = []
  }
  for (const file of files) {
    if (file.endsWith('.json') && !file.startsWith('.')) {
      try {
        await unlink(join(dir, file))
      } catch (error) {
        if (getErrnoCode(error) !== 'ENOENT') throw error
      }
    }
  }
  notifyTasksUpdated()
}

async function releaseLocks(releases: Array<() => Promise<void>>): Promise<void> {
  let firstError: unknown
  for (const release of releases.reverse()) {
    try {
      await release()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError) throw firstError
}

async function releaseTaskAndListLocks(
  releaseTasks: Array<() => Promise<void>>,
  releaseList: (() => Promise<void>) | undefined,
): Promise<void> {
  let firstError: unknown
  try {
    await releaseLocks(releaseTasks)
  } catch (error) {
    firstError = error
  }
  try {
    await releaseList?.()
  } catch (error) {
    firstError ??= error
  }
  if (firstError) throw firstError
}

async function lockTaskFiles(taskListId: string): Promise<Array<() => Promise<void>> | null> {
  let files: string[]
  try {
    files = await readdir(getTasksDir(taskListId))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return null
    throw error
  }

  const releases: Array<() => Promise<void>> = []
  const taskPaths = files
    .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
    .sort()
    .map((file) => join(getTasksDir(taskListId), file))
  for (const taskPath of taskPaths) {
    try {
      releases.push(await lockfile.lock(taskPath, LOCK_OPTIONS))
    } catch (error) {
      await releaseLocks(releases)
      if (getErrnoCode(error) === 'ENOENT') return null
      throw error
    }
  }
  return releases
}

export async function resetTaskList(taskListId: string): Promise<void> {
  const lockPath = await ensureTaskListLockFile(taskListId)
  let releaseList: (() => Promise<void>) | undefined
  let releaseTasks: Array<() => Promise<void>> = []
  try {
    releaseList = await lockfile.lock(lockPath, LOCK_OPTIONS)
    releaseTasks = await lockTaskFiles(taskListId) ?? []
    await resetTaskListUnsafe(taskListId)
  } finally {
    await releaseTaskAndListLocks(releaseTasks, releaseList)
  }
}

/**
 * Whether a completed-task dismiss snapshot still refers to the same cycle.
 *
 * Desktop clear-completed only needs identity of the finished set (id + subject +
 * completed status). Full deep-equal is too brittle: TodoWrite V1 hydration omits
 * description/owner/blocks edges that V2 disk files carry, which made reset return
 * false and the bar reappear after refresh.
 *
 * Still refuse when:
 * - counts / ids differ (new cycle already started)
 * - any current task is not completed
 * - subject changed for the same id (content edited after snapshot)
 */
export function completedTasksMatchResetSnapshot(
  currentTasks: Task[],
  expectedTasks: Task[],
): boolean {
  if (expectedTasks.length === 0 || currentTasks.length !== expectedTasks.length) {
    return false
  }
  const expectedById = new Map(expectedTasks.map(task => [task.id, task]))
  if (expectedById.size !== expectedTasks.length) return false
  if (expectedTasks.some(task => task.status !== 'completed')) return false
  if (currentTasks.some(task => task.status !== 'completed')) return false
  return currentTasks.every(task => {
    const expected = expectedById.get(task.id)
    return expected !== undefined && expected.status === 'completed' && task.subject === expected.subject
  })
}

export async function resetTaskListIfMatches(
  taskListId: string,
  expectedTasks: Task[],
): Promise<boolean> {
  const lockPath = await ensureTaskListLockFile(taskListId)
  let releaseList: (() => Promise<void>) | undefined
  let releaseTasks: Array<() => Promise<void>> = []
  try {
    releaseList = await lockfile.lock(lockPath, LOCK_OPTIONS)
    const lockedTasks = await lockTaskFiles(taskListId)
    if (!lockedTasks) return false
    releaseTasks = lockedTasks

    const currentTasks = await listTasks(taskListId)
    if (!completedTasksMatchResetSnapshot(currentTasks, expectedTasks)) {
      return false
    }

    await resetTaskListUnsafe(taskListId)
    return true
  } finally {
    await releaseTaskAndListLocks(releaseTasks, releaseList)
  }
}

/**
 * Gets the task list ID based on the current context.
 * Priority:
 * 1. In-process teammate: leader's canonical Team list
 * 2. Team name from the active team context
 * 3. Leader team name - set when the leader creates a team via TeamCreate
 * 4. CLAUDE_CODE_TASK_LIST_ID - explicit standalone task list ID
 * 5. Agent ID - a subagent keeps its own list instead of writing the session's
 * 6. Session ID - fallback for standalone sessions
 *
 * A subagent runs in-process, so without step 5 every task it created landed
 * in its parent's list and surfaced in the UI as if the assistant had planned
 * it. Scoping by agent keeps the agent's own tracking — which is what lets it
 * hold a goal across a long run — while keeping it out of the session's list.
 * `TodoWriteTool` has always keyed on `context.agentId ?? getSessionId()`;
 * this brings the task tools in line with it. Teammates are checked first and
 * so keep sharing the leader's list, which is the point of a team.
 */
export function getTaskListId(agentId?: string): string {
  // In-process teammates use the leader's team name so they share the same
  // task list that tmux/iTerm2 teammates also resolve to.
  const teammateCtx = getTeammateContext()
  if (teammateCtx) {
    return getTeamTaskListId(teammateCtx.teamName)
  }
  const teamName = getTeamName() || leaderTeamName
  if (teamName) return getTeamTaskListId(teamName)
  if (process.env.CLAUDE_CODE_TASK_LIST_ID) {
    return process.env.CLAUDE_CODE_TASK_LIST_ID
  }
  return agentId || getSessionId()
}

/** Canonical task-list identity shared by the leader and every teammate backend. */
export function getTeamTaskListId(teamName: string): string {
  return getCanonicalTeamTaskListId(teamName)
}

/**
 * Stable on-disk identity for a Team lifecycle. Unlike getTeamTaskListId(),
 * this must never follow the process-wide standalone task-list override: Team
 * cleanup and archive repair may otherwise delete or tombstone an unrelated
 * list while leaving the Team's own directory behind.
 */
export function getCanonicalTeamTaskListId(teamName: string): string {
  return sanitizeName(teamName)
}

/**
 * Sanitizes a string for safe use in file paths.
 * Removes path traversal characters and other potentially dangerous characters.
 * Only allows alphanumeric characters, hyphens, and underscores.
 */
export function sanitizePathComponent(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function getTasksDir(taskListId: string): string {
  return join(
    getClaudeConfigHomeDir(),
    'tasks',
    sanitizePathComponent(taskListId),
  )
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return join(getTasksDir(taskListId), `${sanitizePathComponent(taskId)}.json`)
}

export async function ensureTasksDir(taskListId: string): Promise<void> {
  if (!isTaskListLifecycleLockHeld(taskListId)) {
    return withActiveTaskListLifecycleLock(taskListId, () => (
      ensureTasksDir(taskListId)
    ))
  }
  const lifecycle = await readTaskListLifecycleState(taskListId)
  if (lifecycle.deleted) {
    throw new Error(`Task list ${taskListId} belongs to a deleted Team lifecycle`)
  }
  const dir = getTasksDir(taskListId)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // Directory already exists or creation failed; callers will surface
    // errors from subsequent operations.
  }
}

/**
 * Finds the highest task ID from existing task files (not including high water mark).
 */
async function findHighestTaskIdFromFiles(taskListId: string): Promise<number> {
  const dir = getTasksDir(taskListId)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return 0
  }
  let highest = 0
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue
    }
    const taskId = parseInt(file.replace('.json', ''), 10)
    if (!isNaN(taskId) && taskId > highest) {
      highest = taskId
    }
  }
  return highest
}

/**
 * Finds the highest task ID ever assigned, considering both existing files
 * and the high water mark (for deleted/reset tasks).
 */
async function findHighestTaskId(taskListId: string): Promise<number> {
  const [fromFiles, fromMark] = await Promise.all([
    findHighestTaskIdFromFiles(taskListId),
    readHighWaterMark(taskListId),
  ])
  return Math.max(fromFiles, fromMark)
}

/**
 * Creates a new task with a unique ID.
 * Uses file locking to prevent race conditions when multiple processes
 * create tasks concurrently.
 */
export type TaskCreationResult = {
  taskId: string
  committedAt: string
  revision: number
}

export async function createTaskWithCommit(
  taskListId: string,
  taskData: Omit<Task, 'id'>,
): Promise<TaskCreationResult> {
  if (!isTaskListLifecycleLockHeld(taskListId)) {
    return withActiveTaskListLifecycleLock(taskListId, () => (
      createTaskWithCommit(taskListId, taskData)
    ))
  }
  await assertTaskListLifecycleActive(taskListId)
  const lockPath = await ensureTaskListLockFile(taskListId)

  let release: (() => Promise<void>) | undefined
  try {
    // Acquire exclusive lock on the task list
    release = await lockfile.lock(lockPath, LOCK_OPTIONS)

    // Read highest ID from disk while holding the lock
    const highestId = await findHighestTaskId(taskListId)
    const id = String(highestId + 1)
    const task: Task = { id, ...taskData }
    const path = getTaskPath(taskListId, id)
    const revision = await bumpTaskListRevisionLocked(taskListId)
    await writeFile(path, jsonStringify(task, null, 2))
    notifyTasksUpdated()
    return { taskId: id, committedAt: new Date().toISOString(), revision }
  } finally {
    if (release) {
      await release()
    }
  }
}

export async function createTask(
  taskListId: string,
  taskData: Omit<Task, 'id'>,
): Promise<string> {
  return (await createTaskWithCommit(taskListId, taskData)).taskId
}

export async function getTask(
  taskListId: string,
  taskId: string,
): Promise<Task | null> {
  const path = getTaskPath(taskListId, taskId)
  try {
    const content = await readFile(path, 'utf-8')
    const data = jsonParse(content) as { status?: string }

    // TEMPORARY: Migrate old status names for existing sessions (ant-only)
    if (process.env.USER_TYPE === 'ant') {
      if (data.status === 'open') data.status = 'pending'
      else if (data.status === 'resolved') data.status = 'completed'
      // Migrate development task statuses to in_progress
      else if (
        data.status &&
        ['planning', 'implementing', 'reviewing', 'verifying'].includes(
          data.status,
        )
      ) {
        data.status = 'in_progress'
      }
    }
    const parsed = TaskSchema().safeParse(data)
    if (!parsed.success) {
      logForDebugging(
        `[Tasks] Task ${taskId} failed schema validation: ${parsed.error.message}`,
      )
      return null
    }
    return parsed.data
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return null
    }
    logForDebugging(`[Tasks] Failed to read task ${taskId}: ${errorMessage(e)}`)
    logError(e)
    return null
  }
}

// Internal: no lock. Callers already holding a lock on taskPath must use this
// to avoid deadlock (claimTask, deleteTask cascade, etc.).
async function updateTaskUnsafe(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  const existing = await getTask(taskListId, taskId)
  if (!existing) {
    return null
  }
  const updated: Task = { ...existing, ...updates, id: taskId }
  const path = getTaskPath(taskListId, taskId)
  await writeFile(path, jsonStringify(updated, null, 2))
  notifyTasksUpdated()
  return updated
}

/**
 * Updates one task while the caller holds the task-list lock. Keeping the
 * lock order list -> task makes owner/status transactions linearizable with
 * create, reset, delete, and both claim paths.
 */
async function updateTaskWhileTaskListLocked(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  const taskPath = getTaskPath(taskListId, taskId)
  if (!await getTask(taskListId, taskId)) return null

  let releaseTask: (() => Promise<void>) | undefined
  try {
    releaseTask = await lockfile.lock(taskPath, LOCK_OPTIONS)
    return await updateTaskUnsafe(taskListId, taskId, updates)
  } finally {
    await releaseTask?.()
  }
}

export type AtomicTaskUpdateResult = {
  previous: Task
  task: Task
  updated: boolean
  committedAt: string
  revision: number
}

export type AtomicTaskUpdateOptions = {
  addBlocks?: string[]
  addBlockedBy?: string[]
}

/**
 * Re-reads a task inside the shared list -> task lock transaction before
 * deciding what to write. Callers use this for conditional ownership and
 * metadata merges that must not overwrite a concurrent claim or deletion.
 */
export async function updateTaskAtomically(
  taskListId: string,
  taskId: string,
  resolveUpdates: (
    current: Readonly<Task>,
  ) => Partial<Omit<Task, 'id'>> | undefined,
  options: AtomicTaskUpdateOptions = {},
): Promise<AtomicTaskUpdateResult | null> {
  if (!isTaskListLifecycleLockHeld(taskListId)) {
    return withActiveTaskListLifecycleLock(taskListId, () => (
      updateTaskAtomically(taskListId, taskId, resolveUpdates, options)
    ))
  }
  await assertTaskListLifecycleActive(taskListId)
  const lockPath = await ensureTaskListLockFile(taskListId)
  const taskPath = getTaskPath(taskListId, taskId)
  let releaseList: (() => Promise<void>) | undefined
  let releaseTask: (() => Promise<void>) | undefined
  try {
    releaseList = await lockfile.lock(lockPath, LOCK_OPTIONS)
    if (!await getTask(taskListId, taskId)) return null
    releaseTask = await lockfile.lock(taskPath, LOCK_OPTIONS)
    const current = await getTask(taskListId, taskId)
    if (!current) return null
    const previous: Task = {
      ...current,
      blocks: [...current.blocks],
      blockedBy: [...current.blockedBy],
      ...(current.metadata ? { metadata: { ...current.metadata } } : {}),
    }
    const updates = { ...(resolveUpdates(previous) ?? {}) }
    const nextBlocks = [...previous.blocks]
    const nextBlockedBy = [...previous.blockedBy]
    const relatedUpdates = new Map<
      string,
      { blocks?: string[]; blockedBy?: string[] }
    >()

    for (const blockedTaskId of uniq(options.addBlocks ?? [])) {
      const blockedTask = blockedTaskId === taskId
        ? previous
        : await getTask(taskListId, blockedTaskId)
      if (!blockedTask) continue
      if (!nextBlocks.includes(blockedTaskId)) nextBlocks.push(blockedTaskId)
      if (blockedTaskId === taskId) {
        if (!nextBlockedBy.includes(taskId)) nextBlockedBy.push(taskId)
        continue
      }
      if (!blockedTask.blockedBy.includes(taskId)) {
        const related = relatedUpdates.get(blockedTaskId) ?? {}
        related.blockedBy = [...blockedTask.blockedBy, taskId]
        relatedUpdates.set(blockedTaskId, related)
      }
    }

    for (const blockerTaskId of uniq(options.addBlockedBy ?? [])) {
      const blockerTask = blockerTaskId === taskId
        ? previous
        : await getTask(taskListId, blockerTaskId)
      if (!blockerTask) continue
      if (!nextBlockedBy.includes(blockerTaskId)) nextBlockedBy.push(blockerTaskId)
      if (blockerTaskId === taskId) {
        if (!nextBlocks.includes(taskId)) nextBlocks.push(taskId)
        continue
      }
      if (!blockerTask.blocks.includes(taskId)) {
        const related = relatedUpdates.get(blockerTaskId) ?? {}
        related.blocks = [...blockerTask.blocks, taskId]
        relatedUpdates.set(blockerTaskId, related)
      }
    }

    if (JSON.stringify(nextBlocks) !== JSON.stringify(previous.blocks)) {
      updates.blocks = nextBlocks
    }
    if (JSON.stringify(nextBlockedBy) !== JSON.stringify(previous.blockedBy)) {
      updates.blockedBy = nextBlockedBy
    }

    for (const key of Object.keys(updates) as Array<keyof Omit<Task, 'id'>>) {
      if (JSON.stringify(updates[key]) === JSON.stringify(previous[key])) {
        delete updates[key]
      }
    }

    const targetChanged = Object.keys(updates).length > 0
    const changed = targetChanged || relatedUpdates.size > 0
    const revision = changed
      ? await bumpTaskListRevisionLocked(taskListId)
      : await readTaskListRevisionLocked(taskListId)
    const updated = targetChanged
      ? await updateTaskUnsafe(taskListId, taskId, updates)
      : current
    if (!updated) return null

    // The list lock is the transaction boundary. Release the target file lock
    // before touching reciprocal edge files, while still excluding every
    // other list writer and watcher snapshot.
    await releaseTask()
    releaseTask = undefined
    for (const [relatedTaskId, related] of relatedUpdates) {
      const relatedTask = await getTask(taskListId, relatedTaskId)
      if (!relatedTask) continue
      const actualUpdates: Partial<Omit<Task, 'id'>> = {}
      if (
        related.blocks &&
        JSON.stringify(related.blocks) !== JSON.stringify(relatedTask.blocks)
      ) actualUpdates.blocks = related.blocks
      if (
        related.blockedBy &&
        JSON.stringify(related.blockedBy) !== JSON.stringify(relatedTask.blockedBy)
      ) actualUpdates.blockedBy = related.blockedBy
      if (Object.keys(actualUpdates).length === 0) continue
      await updateTaskWhileTaskListLocked(taskListId, relatedTaskId, actualUpdates)
    }
    return {
      previous,
      task: updated,
      updated: changed,
      committedAt: new Date().toISOString(),
      revision,
    }
  } finally {
    await releaseTask?.()
    await releaseList?.()
  }
}

export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  return (await updateTaskAtomically(taskListId, taskId, () => updates))?.task ?? null
}

export type TaskDeletionResult = {
  deleted: boolean
  committedAt?: string
  revision?: number
}

export async function deleteTaskWithCommit(
  taskListId: string,
  taskId: string,
): Promise<TaskDeletionResult> {
  if (!isTaskListLifecycleLockHeld(taskListId)) {
    return withActiveTaskListLifecycleLock(taskListId, () => (
      deleteTaskWithCommit(taskListId, taskId)
    ))
  }
  await assertTaskListLifecycleActive(taskListId)
  const path = getTaskPath(taskListId, taskId)
  const lockPath = await ensureTaskListLockFile(taskListId)
  let releaseList: (() => Promise<void>) | undefined

  try {
    releaseList = await lockfile.lock(lockPath, LOCK_OPTIONS)
    if (!await getTask(taskListId, taskId)) return { deleted: false }
    const revision = await bumpTaskListRevisionLocked(taskListId)
    // Update high water mark before deleting to prevent ID reuse
    const numericId = parseInt(taskId, 10)
    if (!isNaN(numericId)) {
      const currentMark = await readHighWaterMark(taskListId)
      if (numericId > currentMark) {
        await writeHighWaterMark(taskListId, numericId)
      }
    }

    // Delete the task file
    await unlink(path)

    const allTasks = await listTasks(taskListId)
    for (const task of allTasks) {
      const newBlocks = task.blocks.filter(id => id !== taskId)
      const newBlockedBy = task.blockedBy.filter(id => id !== taskId)
      if (
        newBlocks.length !== task.blocks.length ||
        newBlockedBy.length !== task.blockedBy.length
      ) {
        await updateTaskWhileTaskListLocked(taskListId, task.id, {
          blocks: newBlocks,
          blockedBy: newBlockedBy,
        })
      }
    }

    notifyTasksUpdated()
    return {
      deleted: true,
      committedAt: new Date().toISOString(),
      revision,
    }
  } finally {
    await releaseList?.()
  }
}

export async function deleteTask(
  taskListId: string,
  taskId: string,
): Promise<boolean> {
  return (await deleteTaskWithCommit(taskListId, taskId)).deleted
}

export async function listTasks(taskListId: string): Promise<Task[]> {
  const dir = getTasksDir(taskListId)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const taskIds = files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
  const results = await Promise.all(taskIds.map(id => getTask(taskListId, id)))
  return results.filter((t): t is Task => t !== null)
}

export type TaskListSnapshot = {
  tasks: Task[]
  capturedAt: string
  revision: number
}

/**
 * Reads one causally ordered task-list snapshot. The timestamp is captured
 * after every task has been read while holding the same list lock used by all
 * writers, so later transcript projections can distinguish a genuinely newer
 * TaskList from a read that merely finished streaming after this snapshot.
 */
export async function readTaskListSnapshot(
  taskListId: string,
): Promise<TaskListSnapshot> {
  if (!isTaskListLifecycleLockHeld(taskListId)) {
    return withTaskListLifecycleLock(taskListId, () => (
      readTaskListSnapshot(taskListId)
    ))
  }
  const lifecycle = await readTaskListLifecycleState(taskListId)
  if (lifecycle.deleted) {
    const terminal = [...lifecycle.terminals].reverse().find(receipt => (
      receipt.generation === lifecycle.generation &&
      taskListLifecycleIdentityMatches(
        receipt.identity,
        lifecycle.activeIdentity,
      )
    ))
    if (!terminal) {
      throw new Error(`Task list ${taskListId} was deleted without a terminal frame`)
    }
    return {
      tasks: terminal.tasks.map(task => ({
        ...task,
        blocks: [...task.blocks],
        blockedBy: [...task.blockedBy],
        ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
      })),
      capturedAt: terminal.capturedAt,
      revision: terminal.revision,
    }
  }
  const lockPath = await ensureTaskListLockFile(taskListId)
  let releaseList: (() => Promise<void>) | undefined
  try {
    releaseList = await lockfile.lock(lockPath, LOCK_OPTIONS)
    const tasks = await listTasks(taskListId)
    const revision = await readTaskListRevisionLocked(taskListId)
    return {
      tasks,
      capturedAt: new Date().toISOString(),
      revision,
    }
  } finally {
    await releaseList?.()
  }
}

export async function blockTask(
  taskListId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<boolean> {
  if (!isTaskListLifecycleLockHeld(taskListId)) {
    return withActiveTaskListLifecycleLock(taskListId, () => (
      blockTask(taskListId, fromTaskId, toTaskId)
    ))
  }
  await assertTaskListLifecycleActive(taskListId)
  const lockPath = await ensureTaskListLockFile(taskListId)
  let releaseList: (() => Promise<void>) | undefined
  try {
    releaseList = await lockfile.lock(lockPath, LOCK_OPTIONS)
    const [fromTask, toTask] = await Promise.all([
      getTask(taskListId, fromTaskId),
      getTask(taskListId, toTaskId),
    ])
    if (!fromTask || !toTask) return false
    const addForward = !fromTask.blocks.includes(toTaskId)
    const addReverse = !toTask.blockedBy.includes(fromTaskId)
    if (addForward || addReverse) {
      await bumpTaskListRevisionLocked(taskListId)
    }

    // Both sides of the edge are one list transaction. Concurrent calls that
    // add A->B and A->C now re-read A after serialization instead of replacing
    // each other's absolute blocks arrays.
    if (addForward) {
      await updateTaskWhileTaskListLocked(taskListId, fromTaskId, {
        blocks: [...fromTask.blocks, toTaskId],
      })
    }
    if (addReverse) {
      await updateTaskWhileTaskListLocked(taskListId, toTaskId, {
        blockedBy: [...toTask.blockedBy, fromTaskId],
      })
    }
    return true
  } finally {
    await releaseList?.()
  }
}

export type ClaimTaskResult = {
  success: boolean
  reason?:
    | 'task_not_found'
    | 'already_claimed'
    | 'already_resolved'
    | 'blocked'
    | 'agent_busy'
  task?: Task
  busyWithTasks?: string[] // task IDs the agent is busy with (when reason is 'agent_busy')
  blockedByTasks?: string[] // task IDs blocking this task (when reason is 'blocked')
}

/**
 * Gets the lock file path for a task list (used for list-level locking)
 */
function getTaskListLockPath(taskListId: string): string {
  return join(getTasksDir(taskListId), '.lock')
}

function getTaskListLifecycleLockPath(taskListId: string): string {
  return join(
    getClaudeConfigHomeDir(),
    'tasks',
    '.lifecycle-locks',
    `${sanitizePathComponent(taskListId)}.lock`,
  )
}

function getTaskListLifecycleStatePath(taskListId: string): string {
  return join(
    getClaudeConfigHomeDir(),
    'tasks',
    '.lifecycle-locks',
    `${sanitizePathComponent(taskListId)}.state.json`,
  )
}

function emptyTaskListLifecycleState(): TaskListLifecycleState {
  return {
    schemaVersion: TASK_LIST_LIFECYCLE_STATE_SCHEMA_VERSION,
    generation: 0,
    deleted: false,
    terminals: [],
  }
}

function taskListLifecycleIdentityMatches(
  left: TaskListTerminalIdentity | undefined,
  right: TaskListTerminalIdentity | undefined,
): boolean {
  return left?.teamName === right?.teamName &&
    left?.createdAt === right?.createdAt &&
    left?.leadSessionId === right?.leadSessionId
}

export async function readTaskListLifecycleState(
  taskListId: string,
): Promise<TaskListLifecycleState> {
  let raw: unknown
  try {
    raw = jsonParse(
      await readFile(getTaskListLifecycleStatePath(taskListId), 'utf-8'),
    )
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return emptyTaskListLifecycleState()
    throw error
  }

  const parsed = z.object({
    schemaVersion: z.literal(TASK_LIST_LIFECYCLE_STATE_SCHEMA_VERSION),
    generation: z.number().int().nonnegative(),
    deleted: z.boolean(),
    activeIdentity: z.object({
      teamName: z.string().min(1),
      createdAt: z.number().finite(),
      leadSessionId: z.string().optional(),
    }).optional(),
    terminals: z.array(z.object({
      frameId: z.string().min(1),
      generation: z.number().int().nonnegative(),
      identity: z.object({
        teamName: z.string().min(1),
        createdAt: z.number().finite(),
        leadSessionId: z.string().optional(),
      }),
      tasks: z.array(TaskSchema()),
      capturedAt: z.string(),
      revision: z.number().int().nonnegative(),
    })).default([]),
  }).passthrough().safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Invalid task-list lifecycle state for ${taskListId}: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

async function writeTaskListLifecycleStateLocked(
  taskListId: string,
  state: TaskListLifecycleState,
): Promise<void> {
  const statePath = getTaskListLifecycleStatePath(taskListId)
  await mkdir(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, jsonStringify(state, null, 2))
    await rename(temporaryPath, statePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

/** Starts a new Team incarnation and invalidates every queued old writer. */
export async function beginTaskListLifecycle(
  taskListId: string,
  identity: TaskListTerminalIdentity,
): Promise<TaskListLifecycleToken> {
  return withTaskListLifecycleLock(taskListId, async () => {
    const previous = await readTaskListLifecycleState(taskListId)
    const generation = previous.generation + 1
    await writeTaskListLifecycleStateLocked(taskListId, {
      ...previous,
      schemaVersion: TASK_LIST_LIFECYCLE_STATE_SCHEMA_VERSION,
      generation,
      deleted: false,
      activeIdentity: identity,
    })
    return { generation, identity }
  })
}

/**
 * Commits the terminal DAG outside the task directory before cleanup removes
 * it. The durable deleted bit prevents a queued TaskCreate from resurrecting
 * an already-ended Team.
 */
export async function completeTaskListLifecycle(
  taskListId: string,
  snapshot: TaskListSnapshot,
  expected: TaskListLifecycleToken,
): Promise<TaskListTerminalReceipt> {
  return withTaskListLifecycleLock(taskListId, async () => {
    const previous = await readTaskListLifecycleState(taskListId)
    if (
      previous.generation !== expected.generation ||
      (
        previous.activeIdentity &&
        !taskListLifecycleIdentityMatches(previous.activeIdentity, expected.identity)
      )
    ) {
      throw new Error(
        `Refusing stale cleanup for task list ${taskListId}: lifecycle identity changed`,
      )
    }
    const existing = previous.terminals.find(receipt => (
      receipt.generation === expected.generation &&
      taskListLifecycleIdentityMatches(receipt.identity, expected.identity)
    ))
    if (previous.deleted && existing) return existing
    const terminal: TaskListTerminalReceipt = {
      ...snapshot,
      frameId: `lifecycle:${expected.generation}:${snapshot.revision}:${snapshot.capturedAt}`,
      generation: expected.generation,
      identity: expected.identity,
    }
    await writeTaskListLifecycleStateLocked(taskListId, {
      ...previous,
      schemaVersion: TASK_LIST_LIFECYCLE_STATE_SCHEMA_VERSION,
      generation: expected.generation,
      deleted: true,
      activeIdentity: expected.identity,
      terminals: [
        ...previous.terminals.filter(receipt => !(
          receipt.generation === expected.generation &&
          taskListLifecycleIdentityMatches(receipt.identity, expected.identity)
        )),
        terminal,
      ].slice(-8),
    })
    return terminal
  })
}

async function withActiveTaskListLifecycleLock<T>(
  taskListId: string,
  run: () => Promise<T>,
): Promise<T> {
  const expected = await readTaskListLifecycleState(taskListId)
  if (expected.deleted) {
    throw new Error(`Task list ${taskListId} belongs to a deleted Team lifecycle`)
  }
  return withTaskListLifecycleLock(taskListId, async () => {
    const current = await readTaskListLifecycleState(taskListId)
    if (
      current.deleted ||
      current.generation !== expected.generation ||
      !taskListLifecycleIdentityMatches(
        current.activeIdentity,
        expected.activeIdentity,
      )
    ) {
      throw new Error(`Task list ${taskListId} lifecycle changed while waiting for the lock`)
    }
    return run()
  })
}

async function assertTaskListLifecycleActive(taskListId: string): Promise<void> {
  const lifecycle = await readTaskListLifecycleState(taskListId)
  if (lifecycle.deleted) {
    throw new Error(`Task list ${taskListId} belongs to a deleted Team lifecycle`)
  }
}

/**
 * Ensures the lock file exists for a task list
 */
async function ensureTaskListLockFile(taskListId: string): Promise<string> {
  await ensureTasksDir(taskListId)
  const lockPath = getTaskListLockPath(taskListId)
  // proper-lockfile requires the target file to exist. Create it with the
  // 'wx' flag (write-exclusive) so concurrent callers don't both create it,
  // and the first one to create wins silently.
  try {
    await writeFile(lockPath, '', { flag: 'wx' })
  } catch {
    // EEXIST or other — file already exists, which is fine.
  }
  return lockPath
}

async function ensureTaskListLifecycleLockFile(
  taskListId: string,
): Promise<string> {
  const lockPath = getTaskListLifecycleLockPath(taskListId)
  await mkdir(dirname(lockPath), { recursive: true })
  try {
    await writeFile(lockPath, '', { flag: 'wx' })
  } catch {
    // The durable lock target is shared across processes and Team deletion.
  }
  return lockPath
}

/**
 * Serializes a joined Team snapshot with whole-directory cleanup. The normal
 * task-list lock lives inside the directory it protects, so it cannot guard
 * against TeamDelete removing that directory and recreating an unrelated lock
 * inode while a watcher is reading it.
 */
export async function withTaskListLifecycleLock<T>(
  taskListId: string,
  run: () => Promise<T>,
): Promise<T> {
  const identity = sanitizePathComponent(taskListId)
  const held = taskListLifecycleContext.getStore()
  if (held?.lease.active && held.held.has(identity)) return run()
  const lockPath = await ensureTaskListLifecycleLockFile(taskListId)
  let release: (() => Promise<void>) | undefined
  const context: TaskListLifecycleContext = {
    held: new Set([...(held?.held ?? []), identity]),
    lease: { active: true },
  }
  try {
    release = await lockfile.lock(lockPath, LOCK_OPTIONS)
    return await taskListLifecycleContext.run(context, run)
  } finally {
    context.lease.active = false
    await release?.()
  }
}

export type ClaimTaskOptions = {
  /**
   * If true, checks whether the agent is already busy (owns other open tasks)
   * before allowing the claim. This check is performed atomically with the claim
   * using a task-list-level lock to prevent TOCTOU race conditions.
   */
  checkAgentBusy?: boolean
  /** Marks ownership and active status in the same lock transaction. */
  markInProgress?: boolean
}

/**
 * Attempts to claim a task for an agent with file locking to prevent race conditions.
 * Returns success if the task was claimed, or a reason if it wasn't.
 *
 * When checkAgentBusy is true, uses a task-list-level lock to atomically check
 * if the agent owns any other open tasks before claiming.
 */
export async function claimTask(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  options: ClaimTaskOptions = {},
): Promise<ClaimTaskResult> {
  if (!isTaskListLifecycleLockHeld(taskListId)) {
    return withActiveTaskListLifecycleLock(taskListId, () => (
      claimTask(taskListId, taskId, claimantAgentId, options)
    ))
  }
  await assertTaskListLifecycleActive(taskListId)
  const taskPath = getTaskPath(taskListId, taskId)

  // Check existence before locking — proper-lockfile.lock throws if the
  // target file doesn't exist, and we want a clean task_not_found result.
  const taskBeforeLock = await getTask(taskListId, taskId)
  if (!taskBeforeLock) {
    return { success: false, reason: 'task_not_found' }
  }

  // If we need to check agent busy status, use task-list-level lock
  // to prevent TOCTOU race conditions
  if (options.checkAgentBusy) {
    return claimTaskWithBusyCheck(
      taskListId,
      taskId,
      claimantAgentId,
      options,
    )
  }

  // All task mutations share the list lock; the nested task lock preserves
  // compatibility with readers/writers that still coordinate per file.
  const lockPath = await ensureTaskListLockFile(taskListId)
  let releaseList: (() => Promise<void>) | undefined
  let releaseTask: (() => Promise<void>) | undefined
  try {
    releaseList = await lockfile.lock(lockPath, LOCK_OPTIONS)
    // Acquire exclusive lock on the task file
    releaseTask = await lockfile.lock(taskPath, LOCK_OPTIONS)

    // Read current task state
    const task = await getTask(taskListId, taskId)
    if (!task) {
      return { success: false, reason: 'task_not_found' }
    }

    // Check if already claimed by another agent
    if (task.owner && task.owner !== claimantAgentId) {
      return { success: false, reason: 'already_claimed', task }
    }

    // Check if already resolved
    if (task.status === 'completed') {
      return { success: false, reason: 'already_resolved', task }
    }

    // Check for unresolved blockers (open or in_progress tasks block)
    const allTasks = await listTasks(taskListId)
    const unresolvedTaskIds = new Set(
      allTasks.filter(t => t.status !== 'completed').map(t => t.id),
    )
    const blockedByTasks = task.blockedBy.filter(id =>
      unresolvedTaskIds.has(id),
    )
    if (blockedByTasks.length > 0) {
      return { success: false, reason: 'blocked', task, blockedByTasks }
    }

    // Claim the task (already holding taskPath lock — use unsafe variant)
    const claimUpdates: Partial<Omit<Task, 'id'>> = {
      owner: claimantAgentId,
      ...(options.markInProgress ? { status: 'in_progress' as const } : {}),
    }
    const needsClaimMutation = task.owner !== claimantAgentId ||
      (options.markInProgress && task.status !== 'in_progress')
    if (needsClaimMutation) await bumpTaskListRevisionLocked(taskListId)
    const updated = needsClaimMutation
      ? await updateTaskUnsafe(taskListId, taskId, claimUpdates)
      : task
    return { success: true, task: updated! }
  } catch (error) {
    logForDebugging(
      `[Tasks] Failed to claim task ${taskId}: ${errorMessage(error)}`,
    )
    logError(error)
    return { success: false, reason: 'task_not_found' }
  } finally {
    await releaseTask?.()
    await releaseList?.()
  }
}

/**
 * Claims a task with an atomic check for agent busy status.
 * Uses a task-list-level lock to ensure the busy check and claim are atomic.
 */
async function claimTaskWithBusyCheck(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  options: ClaimTaskOptions,
): Promise<ClaimTaskResult> {
  const lockPath = await ensureTaskListLockFile(taskListId)

  let release: (() => Promise<void>) | undefined
  try {
    // Acquire exclusive lock on the task list
    release = await lockfile.lock(lockPath, LOCK_OPTIONS)

    // Read all tasks to check agent status and task state atomically
    const allTasks = await listTasks(taskListId)

    // Find the task we want to claim
    const task = allTasks.find(t => t.id === taskId)
    if (!task) {
      return { success: false, reason: 'task_not_found' }
    }

    // Check if already claimed by another agent
    if (task.owner && task.owner !== claimantAgentId) {
      return { success: false, reason: 'already_claimed', task }
    }

    // Check if already resolved
    if (task.status === 'completed') {
      return { success: false, reason: 'already_resolved', task }
    }

    // Check for unresolved blockers (open or in_progress tasks block)
    const unresolvedTaskIds = new Set(
      allTasks.filter(t => t.status !== 'completed').map(t => t.id),
    )
    const blockedByTasks = task.blockedBy.filter(id =>
      unresolvedTaskIds.has(id),
    )
    if (blockedByTasks.length > 0) {
      return { success: false, reason: 'blocked', task, blockedByTasks }
    }

    // Check if agent is busy with other unresolved tasks
    const agentOpenTasks = allTasks.filter(
      t =>
        t.status !== 'completed' &&
        t.owner === claimantAgentId &&
        t.id !== taskId,
    )
    if (agentOpenTasks.length > 0) {
      return {
        success: false,
        reason: 'agent_busy',
        task,
        busyWithTasks: agentOpenTasks.map(t => t.id),
      }
    }

    // Claim the task inside the same list transaction used for the busy check.
    const claimUpdates: Partial<Omit<Task, 'id'>> = {
      owner: claimantAgentId,
      ...(options.markInProgress ? { status: 'in_progress' as const } : {}),
    }
    const needsClaimMutation = task.owner !== claimantAgentId ||
      (options.markInProgress && task.status !== 'in_progress')
    if (needsClaimMutation) await bumpTaskListRevisionLocked(taskListId)
    const updated = needsClaimMutation
      ? await updateTaskWhileTaskListLocked(taskListId, taskId, claimUpdates)
      : task
    return updated
      ? { success: true, task: updated }
      : { success: false, reason: 'task_not_found' }
  } catch (error) {
    logForDebugging(
      `[Tasks] Failed to claim task ${taskId} with busy check: ${errorMessage(error)}`,
    )
    logError(error)
    return { success: false, reason: 'task_not_found' }
  } finally {
    if (release) {
      await release()
    }
  }
}

/**
 * Team member info (subset of TeamFile member structure)
 */
export type TeamMember = {
  agentId: string
  name: string
  agentType?: string
}

/**
 * Agent status based on task ownership
 */
export type AgentStatus = {
  agentId: string
  name: string
  agentType?: string
  status: 'idle' | 'busy'
  currentTasks: string[] // task IDs the agent owns
}

/**
 * Sanitizes a name for use in file paths
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

/**
 * Reads team members from the team file
 */
async function readTeamMembers(
  teamName: string,
): Promise<{ leadAgentId: string; members: TeamMember[] } | null> {
  const teamsDir = getTeamsDir()
  const teamFilePath = join(teamsDir, sanitizeName(teamName), 'config.json')
  try {
    const content = await readFile(teamFilePath, 'utf-8')
    const teamFile = jsonParse(content) as {
      leadAgentId: string
      members: TeamMember[]
    }
    return {
      leadAgentId: teamFile.leadAgentId,
      members: teamFile.members.map(m => ({
        agentId: m.agentId,
        name: m.name,
        agentType: m.agentType,
      })),
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return null
    }
    logForDebugging(
      `[Tasks] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * Gets the status of all agents in a team based on task ownership.
 * An agent is considered "idle" if they don't own any open tasks.
 * An agent is considered "busy" if they own at least one open task.
 *
 * @param teamName - The name of the team (also used as taskListId)
 * @returns Array of agent statuses, or null if team not found
 */
export async function getAgentStatuses(
  teamName: string,
): Promise<AgentStatus[] | null> {
  const teamData = await readTeamMembers(teamName)
  if (!teamData) {
    return null
  }

  const taskListId = sanitizeName(teamName)
  const allTasks = await listTasks(taskListId)

  // Get unresolved tasks grouped by owner (open or in_progress)
  const unresolvedTasksByOwner = new Map<string, string[]>()
  for (const task of allTasks) {
    if (task.status !== 'completed' && task.owner) {
      const existing = unresolvedTasksByOwner.get(task.owner) || []
      existing.push(task.id)
      unresolvedTasksByOwner.set(task.owner, existing)
    }
  }

  // Build status for each agent (leader is already in members)
  return teamData.members.map(member => {
    // Check both name (new) and agentId (legacy) for backwards compatibility
    const tasksByName = unresolvedTasksByOwner.get(member.name) || []
    const tasksById = unresolvedTasksByOwner.get(member.agentId) || []
    const currentTasks = uniq([...tasksByName, ...tasksById])
    return {
      agentId: member.agentId,
      name: member.name,
      agentType: member.agentType,
      status: currentTasks.length === 0 ? 'idle' : 'busy',
      currentTasks,
    }
  })
}

/**
 * Result of unassigning tasks from a teammate
 */
export type UnassignTasksResult = {
  unassignedTasks: Array<{ id: string; subject: string }>
  notificationMessage: string
}

/**
 * Unassigns all open tasks from a teammate and builds a notification message.
 * Used when a teammate is killed or gracefully shuts down.
 *
 * @param teamName - The team/task list name
 * @param teammateId - The teammate's agent ID
 * @param teammateName - The teammate's display name
 * @param reason - How the teammate exited ('terminated' | 'shutdown')
 * @returns The unassigned tasks and a formatted notification message
 */
export async function unassignTeammateTasks(
  teamName: string,
  teammateId: string,
  teammateName: string,
  reason: 'terminated' | 'shutdown',
): Promise<UnassignTasksResult> {
  const tasks = await listTasks(teamName)
  const unresolvedAssignedTasks = tasks.filter(
    t =>
      t.status !== 'completed' &&
      (t.owner === teammateId || t.owner === teammateName),
  )

  // Re-check ownership inside the task-list transaction so shutdown cleanup
  // cannot erase a reassignment that another actor committed after this scan.
  const unassignedTasks: Array<{ id: string; subject: string }> = []
  for (const task of unresolvedAssignedTasks) {
    const result = await updateTaskAtomically(teamName, task.id, (current) => {
      if (
        current.status === 'completed' ||
        (current.owner !== teammateId && current.owner !== teammateName)
      ) return undefined
      return { owner: undefined, status: 'pending' }
    })
    if (result?.updated) {
      unassignedTasks.push({ id: result.task.id, subject: result.task.subject })
    }
  }

  if (unassignedTasks.length > 0) {
    logForDebugging(
      `[Tasks] Unassigned ${unassignedTasks.length} task(s) from ${teammateName}`,
    )
  }

  // Build notification message
  const actionVerb =
    reason === 'terminated' ? 'was terminated' : 'has shut down'
  let notificationMessage = `${teammateName} ${actionVerb}.`
  if (unassignedTasks.length > 0) {
    const taskList = unassignedTasks
      .map(t => `#${t.id} "${t.subject}"`)
      .join(', ')
    notificationMessage += ` ${unassignedTasks.length} task(s) were unassigned: ${taskList}. Use TaskList to check availability and TaskUpdate with owner to reassign them to idle teammates.`
  }

  return {
    unassignedTasks,
    notificationMessage,
  }
}

export const DEFAULT_TASKS_MODE_TASK_LIST_ID = 'tasklist'
