import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalSimpleMode = process.env.CLAUDE_CODE_SIMPLE

describe('analyzeContextUsage', () => {
  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'cc-haha-analyze-context-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_SIMPLE = '1'
  })

  afterAll(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalSimpleMode === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = originalSimpleMode
    }
    await rm(configDir, { recursive: true, force: true })
  })

  test('analyzes attachment messages for the context status view', async () => {
    const { analyzeContextUsage } = await import('./analyzeContext.js')

    const result = await analyzeContextUsage(
      [
        {
          type: 'attachment',
          attachment: { type: 'directory', path: configDir },
          uuid: 'issue-1022',
          timestamp: '2026-07-17T00:00:00.000Z',
        },
      ],
      'claude-sonnet-4-20250514',
      async () => ({ mode: 'default' }),
      [],
      { activeAgents: [], allAgents: [] },
      undefined,
      undefined,
      undefined,
      undefined,
      { estimateOnly: true },
    )

    expect(result.messageBreakdown?.attachmentTokens).toBeGreaterThan(0)
    expect(result.messageBreakdown?.attachmentsByType).toEqual([
      { name: 'directory', tokens: expect.any(Number) },
    ])
  })
})
