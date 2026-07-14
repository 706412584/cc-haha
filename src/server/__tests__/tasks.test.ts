/**
 * Unit tests for TaskService and Tasks API
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { TaskService } from '../services/taskService.js'
import {
  deleteTask,
  resetTaskList,
  resetTaskListIfMatches,
  TaskSchema,
} from '../../utils/tasks.js'
import * as taskLockfile from '../../utils/lockfile.js'

const taskFixture = (overrides: Record<string, unknown>) => ({
  id: '1',
  subject: 'Test task',
  description: '',
  status: 'pending',
  blocks: [],
  blockedBy: [],
  ...overrides,
})

// ============================================================================
// TaskService unit tests
// ============================================================================

describe('TaskService', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-tasks-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('should return empty list when no tasks dir', async () => {
    const svc = new TaskService()
    const tasks = await svc.listTasks()
    expect(tasks).toEqual([])
  })

  it('should list tasks from JSON files', async () => {
    const tasksDir = path.join(tmpDir, 'tasks', 'default-list')
    await fs.mkdir(tasksDir, { recursive: true })

    await fs.writeFile(path.join(tasksDir, '1.json'), JSON.stringify(taskFixture({
      id: 'task-001',
      subject: 'code-review',
      status: 'completed',
      description: 'Review PR #42',
    })))

    await fs.writeFile(path.join(tasksDir, '2.json'), JSON.stringify(taskFixture({
      id: 'task-002',
      subject: 'frontend-dev',
      status: 'in_progress',
      owner: 'ui-team',
    })))

    const svc = new TaskService()
    const tasks = await svc.listTasks()
    expect(tasks.length).toBe(2)
    expect(tasks[0].id).toBe('task-001')
    expect(tasks[1].id).toBe('task-002')
  })

  it('should scan nested team task directories', async () => {
    const teamDir = path.join(tmpDir, 'tasks', 'my-team')
    await fs.mkdir(teamDir, { recursive: true })

    await fs.writeFile(path.join(teamDir, 'member-1.json'), JSON.stringify(taskFixture({
      id: 'member-1',
      subject: 'Implement feature',
      status: 'completed',
    })))

    const svc = new TaskService()
    const tasks = await svc.listTasks()
    expect(tasks.length).toBe(1)
    expect(tasks[0].taskListId).toBe('my-team')
  })

  it('should get single task by ID', async () => {
    const tasksDir = path.join(tmpDir, 'tasks', 'default-list')
    await fs.mkdir(tasksDir, { recursive: true })

    await fs.writeFile(path.join(tasksDir, 'abc.json'), JSON.stringify(taskFixture({
      id: 'abc',
      subject: 'build',
      status: 'completed',
    })))

    const svc = new TaskService()
    const task = await svc.getTask('default-list', 'abc')
    expect(task).toBeDefined()
    expect(task!.status).toBe('completed')
  })

  it('should return null for unknown task', async () => {
    const svc = new TaskService()
    const task = await svc.getTask('nonexistent')
    expect(task).toBeNull()
  })

  it('should skip invalid JSON files gracefully', async () => {
    const tasksDir = path.join(tmpDir, 'tasks', 'default-list')
    await fs.mkdir(tasksDir, { recursive: true })
    await fs.writeFile(path.join(tasksDir, 'bad.json'), 'not json {{{')

    const svc = new TaskService()
    const tasks = await svc.listTasks()
    expect(tasks).toEqual([])
  })

  it('should list all tasks without reading task lists twice', async () => {
    const firstListDir = path.join(tmpDir, 'tasks', 'first-list')
    const secondListDir = path.join(tmpDir, 'tasks', 'second-list')
    await fs.mkdir(firstListDir, { recursive: true })
    await fs.mkdir(secondListDir, { recursive: true })

    await fs.writeFile(path.join(firstListDir, '1.json'), JSON.stringify(taskFixture({
      id: '1',
      subject: 'first task',
    })))
    await fs.writeFile(path.join(secondListDir, '2.json'), JSON.stringify(taskFixture({
      id: '2',
      subject: 'second task',
    })))

    const originalReadFile = fs.readFile
    let taskFileReadCount = 0
    const readFileSpy = spyOn(fs, 'readFile').mockImplementation((...args) => {
      const filePath = String(args[0])
      if (filePath.startsWith(path.join(tmpDir, 'tasks')) && filePath.endsWith('.json')) {
        taskFileReadCount++
      }
      return originalReadFile(...args)
    })

    try {
      const svc = new TaskService()
      const tasks = await svc.listTasks()
      expect(tasks.map((task) => task.id).sort()).toEqual(['1', '2'])
      expect(taskFileReadCount).toBe(2)
    } finally {
      readFileSpy.mockRestore()
    }
  })
})

// ============================================================================
// Tasks API integration tests
// ============================================================================

describe('Tasks API', () => {
  let server: any
  let baseUrl: string
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-tasks-api-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })

    const { startServer } = await import('../../server/index.js')
    server = startServer(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('should return empty tasks list', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`)
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.tasks).toEqual([])
  })

  it('should return tasks when files exist', async () => {
    const tasksDir = path.join(tmpDir, 'tasks', 'default-list')
    await fs.mkdir(tasksDir, { recursive: true })
    await fs.writeFile(path.join(tasksDir, 'test.json'), JSON.stringify(taskFixture({
      id: 'test',
      status: 'completed',
      subject: 'test-task',
    })))

    const res = await fetch(`${baseUrl}/api/tasks`)
    const data = await res.json()
    expect(data.tasks.length).toBe(1)
    expect(data.tasks[0].subject).toBe('test-task')
  })

  it('should return 404 for unknown task', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/lists/default-list/nonexistent`)
    expect(res.status).toBe(404)
  })

  it('should reset a persisted task list', async () => {
    const taskListDir = path.join(tmpDir, 'tasks', 'desktop-session-1')
    await fs.mkdir(taskListDir, { recursive: true })
    await fs.writeFile(path.join(taskListDir, '1.json'), JSON.stringify(taskFixture({
      id: '1',
      subject: 'First task',
      status: 'completed',
    })))
    await fs.writeFile(path.join(taskListDir, '2.json'), JSON.stringify(taskFixture({
      id: '2',
      subject: 'Second task',
      status: 'completed',
    })))

    const before = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1`)
    expect(before.status).toBe(200)
    expect((await before.json()).tasks).toHaveLength(2)

    const reset = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedTasks: [
          taskFixture({ id: '1', subject: 'First task', status: 'completed' }),
          taskFixture({ id: '2', subject: 'Second task', status: 'completed' }),
        ],
      }),
    })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ ok: true, reset: true })

    const after = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1`)
    expect(after.status).toBe(200)
    expect((await after.json()).tasks).toEqual([])
  })

  it('should preserve a newer task cycle when resetting an older completed snapshot', async () => {
    const taskListDir = path.join(tmpDir, 'tasks', 'desktop-session-1')
    await fs.mkdir(taskListDir, { recursive: true })
    await fs.writeFile(path.join(taskListDir, '1.json'), JSON.stringify(taskFixture({
      id: '1',
      subject: 'Completed task',
      status: 'completed',
    })))
    await fs.writeFile(path.join(taskListDir, '2.json'), JSON.stringify(taskFixture({
      id: '2',
      subject: 'New cycle task',
      status: 'in_progress',
    })))

    const reset = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedTasks: [taskFixture({ id: '1', subject: 'Completed task', status: 'completed' })],
      }),
    })

    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ ok: true, reset: false })

    const after = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1`)
    expect((await after.json()).tasks).toHaveLength(2)
  })

  it('should preserve a completed task whose content changed after the reset snapshot', async () => {
    const taskListDir = path.join(tmpDir, 'tasks', 'desktop-session-1')
    await fs.mkdir(taskListDir, { recursive: true })
    await fs.writeFile(path.join(taskListDir, '1.json'), JSON.stringify(taskFixture({
      id: '1',
      subject: 'Updated completed task',
      status: 'completed',
    })))

    const reset = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedTasks: [taskFixture({
          id: '1',
          subject: 'Original completed task',
          status: 'completed',
        })],
      }),
    })

    expect(reset.status).toBe(200)
    expect(await reset.json()).toEqual({ ok: true, reset: false })
    const after = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1`)
    expect((await after.json()).tasks[0].subject).toBe('Updated completed task')
  })

  it('should wait for an in-flight task update before comparing the reset snapshot', async () => {
    const taskListDir = path.join(tmpDir, 'tasks', 'desktop-session-1')
    const taskPath = path.join(taskListDir, '1.json')
    await fs.mkdir(taskListDir, { recursive: true })
    const originalTask = taskFixture({
      id: '1',
      subject: 'Original completed task',
      status: 'completed',
    })
    await fs.writeFile(taskPath, JSON.stringify(originalTask))
    const releaseUpdate = await taskLockfile.lock(taskPath)
    const originalLock = taskLockfile.lock
    let signalTaskLockRequested: (() => void) | null = null
    const taskLockRequested = new Promise<void>((resolve) => {
      signalTaskLockRequested = resolve
    })
    const lockSpy = spyOn(taskLockfile, 'lock').mockImplementation((file, options) => {
      if (file === taskPath) signalTaskLockRequested?.()
      return originalLock(file, options)
    })

    try {
      const reset = resetTaskListIfMatches(
        'desktop-session-1',
        [TaskSchema().parse(originalTask)],
      )
      await taskLockRequested
      await fs.writeFile(taskPath, JSON.stringify({
        ...originalTask,
        subject: 'Updated completed task',
      }))
      await releaseUpdate()

      expect(await reset).toBe(false)
      expect(JSON.parse(await fs.readFile(taskPath, 'utf-8')).subject).toBe('Updated completed task')
    } finally {
      lockSpy.mockRestore()
    }
  })

  it('should wait for an in-flight task update before ordinary reset', async () => {
    const taskListDir = path.join(tmpDir, 'tasks', 'desktop-session-1')
    const taskPath = path.join(taskListDir, '1.json')
    await fs.mkdir(taskListDir, { recursive: true })
    await fs.writeFile(taskPath, JSON.stringify(taskFixture({ status: 'completed' })))
    const releaseUpdate = await taskLockfile.lock(taskPath)
    const originalLock = taskLockfile.lock
    let signalTaskLockRequested: (() => void) | null = null
    const taskLockRequested = new Promise<void>((resolve) => {
      signalTaskLockRequested = resolve
    })
    const lockSpy = spyOn(taskLockfile, 'lock').mockImplementation((file, options) => {
      if (file === taskPath) signalTaskLockRequested?.()
      return originalLock(file, options)
    })

    try {
      const reset = resetTaskList('desktop-session-1')
      await taskLockRequested
      expect(await fs.readFile(taskPath, 'utf-8')).toContain('Test task')
      await releaseUpdate()
      await reset
      await expect(fs.access(taskPath)).rejects.toThrow()
    } finally {
      lockSpy.mockRestore()
    }
  })

  it('should wait for an in-flight task update before deleting it', async () => {
    const taskListDir = path.join(tmpDir, 'tasks', 'desktop-session-1')
    const taskPath = path.join(taskListDir, '1.json')
    await fs.mkdir(taskListDir, { recursive: true })
    await fs.writeFile(taskPath, JSON.stringify(taskFixture({ status: 'completed' })))
    const releaseUpdate = await taskLockfile.lock(taskPath)
    const originalLock = taskLockfile.lock
    let signalTaskLockRequested: (() => void) | null = null
    const taskLockRequested = new Promise<void>((resolve) => {
      signalTaskLockRequested = resolve
    })
    const lockSpy = spyOn(taskLockfile, 'lock').mockImplementation((file, options) => {
      if (file === taskPath) signalTaskLockRequested?.()
      return originalLock(file, options)
    })

    try {
      const deletion = deleteTask('desktop-session-1', '1')
      await taskLockRequested
      expect(await fs.readFile(taskPath, 'utf-8')).toContain('Test task')
      await releaseUpdate()
      expect(await deletion).toBe(true)
      await expect(fs.access(taskPath)).rejects.toThrow()
    } finally {
      lockSpy.mockRestore()
    }
  })

  it('should reject invalid or oversized reset snapshots', async () => {
    const nullBody = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    })
    expect(nullBody.status).toBe(400)

    const oversized = await fetch(`${baseUrl}/api/tasks/lists/desktop-session-1/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedTasks: [], padding: 'x'.repeat(512 * 1024) }),
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: 'PAYLOAD_TOO_LARGE' })
  })

  it('should reject non-GET methods', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
