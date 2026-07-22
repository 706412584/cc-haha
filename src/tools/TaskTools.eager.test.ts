import { describe, expect, it } from 'bun:test'
import { TaskCreateTool } from './TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './TaskGetTool/TaskGetTool.js'
import { TaskListTool } from './TaskListTool/TaskListTool.js'
import { TaskUpdateTool } from './TaskUpdateTool/TaskUpdateTool.js'
import { isDeferredTool } from './ToolSearchTool/prompt.js'

describe('Task tool discovery', () => {
  it('keeps the complete task lifecycle available without ToolSearch', () => {
    for (const tool of [
      TaskCreateTool,
      TaskGetTool,
      TaskListTool,
      TaskUpdateTool,
    ]) {
      expect(tool.alwaysLoad).toBe(true)
      expect(isDeferredTool(tool)).toBe(false)
    }
  })
})

describe('Task tool execution ordering', () => {
  it('serializes task reads against concurrent task mutations', () => {
    expect(TaskGetTool.isConcurrencySafe({ taskId: '1' })).toBe(false)
    expect(TaskListTool.isConcurrencySafe({})).toBe(false)
  })
})
