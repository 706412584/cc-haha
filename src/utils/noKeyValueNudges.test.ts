import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TodoWriteTool } from '../tools/TodoWriteTool/TodoWriteTool.js'

/**
 * Edit and task counts are not evidence that verification is needed. Keep
 * the removed count-based nudges from returning, and retain the generic guard
 * against model-facing `key="value"` Agent parameter fragments.
 */

const REPO_ROOT = join(__dirname, '..', '..')

function loadSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

const FORBIDDEN_KEYS = ['subagent_type', 'description', 'prompt']

function findKeyValueAttrs(source: string): string[] {
  const hits: string[] = []
  for (const key of FORBIDDEN_KEYS) {
    // Match `key="value"` and `key='value'` shapes inside any string
    // literal, with optional whitespace around the `=`. The `subagent_type`
    // identifier appears inside types/code legitimately (e.g. as a property
    // name), so we narrow to "looks like an attribute fragment in a model
    // message" by requiring the backtick or quote *before* the key —
    // i.e. the key sits inside an interpolated string literal.
    const rx = new RegExp(`["'\`\\s][^"'\`\\n]*\\b${key}\\s*=\\s*["'][^"']+["']`, 'g')
    let m: RegExpExecArray | null
    while ((m = rx.exec(source)) !== null) {
      hits.push(m[0])
    }
  }
  return hits
}

describe('model-facing nudges do not embed key="value" attribute fragments', () => {
  it('does not inject verification reminders based on edit or task counts', () => {
    const result = TodoWriteTool.mapToolResultToToolResultBlockParam(
      { oldTodos: [], newTodos: [] },
      'tool-use-id',
    )
    expect(result.content).toBe(
      'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable',
    )

    const messages = loadSource('src/utils/messages.ts')
    const attachments = loadSource('src/utils/attachments.ts')
    const todoWrite = loadSource('src/tools/TodoWriteTool/TodoWriteTool.ts')
    const taskUpdate = loadSource('src/tools/TaskUpdateTool/TaskUpdateTool.ts')

    for (const source of [messages, attachments, todoWrite, taskUpdate]) {
      expect(findKeyValueAttrs(source)).toEqual([])
      expect(source).not.toContain('verification_gate_reminder')
      expect(source).not.toContain('verificationNudgeNeeded')
      expect(source).not.toContain('Confirm that you ran focused checks')
    }
  })
})
