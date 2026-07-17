import { describe, expect, test } from 'bun:test'
import { parseOrchestrationMetadata } from './orchestrationMetadata.js'

describe('parseOrchestrationMetadata', () => {
  test('accepts schema v1 metadata and normalizes repo-relative file scope paths', () => {
    expect(
      parseOrchestrationMetadata({
        orchestration: {
          schemaVersion: 1,
          fileScope: ['./src/tools/TaskCreateTool/../TaskCreateTool/prompt.ts', 'src\\utils\\messages.ts'],
          wave: 1,
          execution: 'background-agent',
          verification: 'Run focused prompt tests',
        },
      }),
    ).toEqual({
      schemaVersion: 1,
      fileScope: ['src/tools/TaskCreateTool/prompt.ts', 'src/utils/messages.ts'],
      wave: 1,
      execution: 'background-agent',
      verification: 'Run focused prompt tests',
    })
  })

  test('returns null for unknown, malformed, old, or absolute metadata', () => {
    const invalidValues = [
      undefined,
      {},
      { orchestration: { schemaVersion: 0 } },
      {
        orchestration: {
          schemaVersion: 1,
          fileScope: ['src/a.ts'],
          wave: 0,
          execution: 'background-agent',
          verification: 'Run tests',
        },
      },
      {
        orchestration: {
          schemaVersion: 1,
          fileScope: ['C:/repo/src/a.ts'],
          wave: 1,
          execution: 'background-agent',
          verification: 'Run tests',
        },
      },
      {
        orchestration: {
          schemaVersion: 1,
          fileScope: ['../outside.ts'],
          wave: 1,
          execution: 'background-agent',
          verification: 'Run tests',
        },
      },
      {
        orchestration: {
          schemaVersion: 1,
          fileScope: ['src/a.ts'],
          wave: 1,
          execution: 'agent',
          verification: 'Run tests',
        },
      },
      {
        orchestration: {
          schemaVersion: 1,
          fileScope: ['src/a.ts'],
          wave: 1,
          execution: 'main',
          verification: 'Run tests',
          unexpected: true,
        },
      },
    ]

    for (const value of invalidValues) {
      expect(parseOrchestrationMetadata(value)).toBeNull()
    }
  })
})
