import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'

/**
 * These go through the real `SessionService.getSessionHistoryRecovery` rather
 * than a hand-rolled `toMessage`. The bug they lock lives in how the recovery
 * stores `toolUseResult` for workspace entries, and a stub that drops that field
 * reproduces nothing — the first version of this suite passed both before and
 * after the fix.
 */

let tmpDir: string
let previousConfigDir: string | undefined
const SESSION_ID = 'f4ff05c4-4e4f-47d5-b99c-ee3bdf1ef469'
const PROJECT_DIR = 'E--ai-dsh-git'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-recovery-workspace-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (previousConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function seedTranscript(lines: unknown[]): Promise<void> {
  const dir = path.join(tmpDir, 'projects', PROJECT_DIR)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${SESSION_ID}.jsonl`),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  )
}

function recover() {
  return new SessionService().getSessionHistoryRecovery(SESSION_ID)
}

const TARGET = 'E:\\ai\\dsh-git\\.github\\workflows\\release.yml'
/** Large enough that one edit entry alone exceeds the 64KB state budget. */
const BIG_FILE_BODY = 'x'.repeat(66_000)

function assistantEdit(id: string) {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name: 'Edit',
        input: { file_path: TARGET, old_string: 'old line', new_string: 'new line' },
      }],
    },
  }
}

/** Mirrors the edit tools: the result carries the whole pre-edit file. */
function editToolResult(toolUseId: string) {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:00:01.000Z',
    toolUseResult: {
      filePath: TARGET,
      oldString: 'old line',
      newString: 'new line',
      originalFile: BIG_FILE_BODY,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old line', '+new line'] }],
      userModified: false,
      replaceAll: false,
    },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'The file has been updated successfully.' }],
    },
  }
}

describe('workspace recovery with an edit result carrying a large originalFile', () => {
  test('keeps the workspace complete when an edit snapshot exceeds the state budget', async () => {
    // Regression: `originalFile` is the whole pre-edit file. One edit to a ~60KB
    // file produced a ~67KB workspace entry whose tool_result was 174 bytes —
    // past STATE_RECORD_BYTES (64KB). That marked the workspace incomplete, so
    // the API answered 413 HISTORY_WORKSPACE_LIMIT and the session's change view
    // stayed permanently unusable.
    await seedTranscript([assistantEdit('call_big'), editToolResult('call_big')])

    const recovery = await recover()

    expect(recovery.completeness?.workspace).toBe(true)
    expect(recovery.status).toBe('ready')
    expect(recovery.omittedRecords).toBe(0)
  })

  test('does not keep the pre-edit snapshot in recovery state', async () => {
    await seedTranscript([assistantEdit('call_slim'), editToolResult('call_slim')])

    const recovery = await recover()

    // The 62KB snapshot must not be resident; the fields the workspace view
    // reads (file path, old/new string) must survive.
    const json = JSON.stringify(recovery)
    expect(json).not.toContain('xxxxxxxxxx')
    expect(json).toContain('old line')
    expect(json).toContain('new line')
  })

  test('stays complete across several edits to the same large file', async () => {
    // The reported session had four such edits in a row.
    await seedTranscript([0, 1, 2, 3].flatMap(n => [
      assistantEdit(`call_multi_${n}`),
      editToolResult(`call_multi_${n}`),
    ]))

    const recovery = await recover()

    expect(recovery.completeness?.workspace).toBe(true)
    expect(recovery.status).toBe('ready')
    expect(recovery.omittedRecords).toBe(0)
  })

  test('leaves a non-edit result untouched', async () => {
    await seedTranscript([
      {
        parentUuid: null,
        isSidechain: false,
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_shell', name: 'Bash', input: { command: 'sleep 1', run_in_background: true } }],
        },
      },
      {
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:01.000Z',
        toolUseResult: { backgroundTaskId: 'task-1' },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_shell', content: 'Command running in background with ID: task-1' }],
        },
      },
    ])

    const recovery = await recover()

    // Shell results carry no originalFile, so the desktop still gets the
    // backgroundTaskId it uses to rebuild background tasks.
    expect(JSON.stringify(recovery)).toContain('task-1')
  })
})
