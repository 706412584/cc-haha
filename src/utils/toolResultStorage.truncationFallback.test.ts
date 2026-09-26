import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  IN_MEMORY_TRUNCATION_CHARS,
  PERSISTED_OUTPUT_CLOSING_TAG,
  PERSISTED_OUTPUT_TAG,
  createContentReplacementState,
  enforceToolResultBudget,
  processToolResultBlock,
} from './toolResultStorage.js'
import * as toolResultStorage from './toolResultStorage.js'
import type { Message } from '../types/message.js'

function makeTool() {
  return {
    name: 'test-tool',
    // Infinity opts the tool out of persistence entirely; a finite cap keeps it
    // in scope so the failure path is the one under test.
    maxResultSizeChars: 50_000,
    mapToolResultToToolResultBlockParam: (result: ToolResultBlockParam) => result,
  }
}

function oversizedTextBlock(chars: number): ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: 'tool-oversized',
    content: [{ type: 'text', text: 'x'.repeat(chars) }],
  }
}

let tmpDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-result-fallback-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (previousConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('oversized tool result when persistence fails', () => {
  test('truncates in memory instead of returning the oversized content unchanged', async () => {
    // Regression: the failure branch used to `return toolResultBlock`, so a
    // failed write made the 50k persistence threshold unbounded. The full
    // result then landed in the transcript, and a record above the 8MB
    // semantic read limit is skipped by every metadata/history fold — one such
    // record could leave a session unable to resolve its launch info.
    const persistSpy = spyOn(toolResultStorage, 'persistToolResult').mockResolvedValue({
      error: 'ENOSPC: no space left on device',
    })
    try {
      const block = oversizedTextBlock(400_000)
      const processed = await processToolResultBlock(makeTool(), block, 'tool-oversized')

      const content = processed.content as string
      expect(typeof content).toBe('string')
      // The oversized payload must not survive verbatim.
      expect(content.length).toBeLessThan(IN_MEMORY_TRUNCATION_CHARS + 1_000)
      expect(content).toContain(PERSISTED_OUTPUT_TAG)
      expect(content).toContain(PERSISTED_OUTPUT_CLOSING_TAG)
      // It must say the save failed, so the model does not try to read a file.
      expect(content).toContain('could not be saved')
      expect(persistSpy).toHaveBeenCalled()
    } finally {
      persistSpy.mockRestore()
    }
  })

  test('keeps a usable preview so the turn is not a dead end', async () => {
    const persistSpy = spyOn(toolResultStorage, 'persistToolResult').mockResolvedValue({
      error: 'EACCES: permission denied',
    })
    try {
      const block: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: 'tool-preview',
        content: [{ type: 'text', text: `HEAD-MARKER\n${'y'.repeat(300_000)}\nTAIL-MARKER` }],
      }
      const processed = await processToolResultBlock(makeTool(), block, 'tool-preview')
      const content = processed.content as string

      expect(content).toContain('HEAD-MARKER')
      // Truncation is real, so the tail cannot be present.
      expect(content).not.toContain('TAIL-MARKER')
    } finally {
      persistSpy.mockRestore()
    }
  })

  test('leaves a result at or below the threshold untouched', async () => {
    const persistSpy = spyOn(toolResultStorage, 'persistToolResult').mockResolvedValue({
      error: 'should not be reached',
    })
    try {
      const block = oversizedTextBlock(1_000)
      const processed = await processToolResultBlock(makeTool(), block, 'tool-small')
      expect(processed).toEqual(block)
      expect(persistSpy).not.toHaveBeenCalled()
    } finally {
      persistSpy.mockRestore()
    }
  })

  test('keeps structured blocks instead of flattening them into a placeholder', async () => {
    // persistToolResult only accepts pure text, so a payload mixing long text
    // with a document block lands on the failure path without any write being
    // attempted. Flattening the document into "[document]" would drop content
    // the caller never agreed to lose; only the text may be truncated.
    const persistSpy = spyOn(toolResultStorage, 'persistToolResult').mockResolvedValue({
      error: 'Cannot persist tool results containing non-text content',
    })
    try {
      const document = {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
      }
      const block = {
        type: 'tool_result',
        tool_use_id: 'tool-mixed',
        content: [{ type: 'text', text: 'T'.repeat(60_000) }, document],
      } as unknown as ToolResultBlockParam

      const processed = await processToolResultBlock(makeTool(), block, 'tool-mixed')
      const content = processed.content as Array<{ type: string }>

      expect(Array.isArray(content)).toBe(true)
      expect(content.map(b => b.type)).toEqual(['text', 'document'])
      // The document survived byte-for-byte.
      expect(content[1]).toEqual(document)
      // ...and the oversized text did not.
      expect((content[0] as unknown as { text: string }).text.length).toBeLessThan(IN_MEMORY_TRUNCATION_CHARS + 1_000)
    } finally {
      persistSpy.mockRestore()
    }
  })

  test('applies the per-message budget even when persistence fails', async () => {
    // The aggregate budget path had the same bug as the single-result path:
    // buildReplacement returned null on a failed persist and the oversized
    // content stayed in the message, so the budget silently stopped applying.
    const persistSpy = spyOn(toolResultStorage, 'persistToolResult').mockResolvedValue({
      error: 'ENOSPC: no space left on device',
    })
    try {
      const message = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'budget-a', content: 'A'.repeat(150_000) },
            { type: 'tool_result', tool_use_id: 'budget-b', content: 'B'.repeat(150_000) },
          ],
        },
      } as unknown as Message

      const { messages, newlyReplaced } = await enforceToolResultBudget(
        [message],
        createContentReplacementState(),
      )
      // The budget replaces the largest fresh result(s) until the group's
      // *pre-replacement* total fits the limit, so one 150k block is replaced
      // here and the other is left alone by design. What matters for this
      // regression is that a failed persist still yields a truncated
      // replacement instead of leaving the oversized content untouched.
      expect(newlyReplaced.length).toBeGreaterThan(0)
      const blocks = messages[0]!.message.content as Array<{ content: unknown }>
      const replaced = blocks.filter(
        b => typeof b.content === 'string' && (b.content as string).includes(PERSISTED_OUTPUT_TAG),
      )
      expect(replaced.length).toBeGreaterThan(0)
      for (const block of replaced) {
        const text = block.content as string
        expect(text).toContain('could not be saved')
        expect(text.length).toBeLessThan(IN_MEMORY_TRUNCATION_CHARS + 1_000)
      }
    } finally {
      persistSpy.mockRestore()
    }
  })

  test('still returns the file pointer when persistence succeeds', async () => {
    const block = oversizedTextBlock(400_000)
    const processed = await processToolResultBlock(makeTool(), block, 'tool-ok')
    const content = processed.content as string

    // The persisted file is named after the block's tool_use_id, which is what
    // the model is told to read back.
    expect(content).toContain('Full output saved to:')
    expect(content).toContain(`${block.tool_use_id}.json`)
    expect(content).not.toContain('could not be saved')
  })
})
