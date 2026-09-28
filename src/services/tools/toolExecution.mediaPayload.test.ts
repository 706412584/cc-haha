import { describe, expect, test } from 'bun:test'
import { stripDuplicatedMediaPayload } from './toolExecution.js'

/**
 * Regression: the FileRead tool returns an image as both an `image` content
 * block and `toolUseResult.file.base64` — the same bytes twice. One ~4MB
 * screenshot made a ~8MB transcript record, past HISTORY_SEMANTIC_RECORD_BYTES,
 * so the history reader dropped the whole record and the message vanished from
 * the timeline. Dropping the duplicate halves the record.
 */
describe('stripDuplicatedMediaPayload', () => {
  test('drops the duplicated base64 but keeps the structural metadata', () => {
    const base64 = 'A'.repeat(4 * 1024 * 1024)
    const result = {
      type: 'image',
      file: {
        base64,
        type: 'image/png',
        originalSize: base64.length,
        dimensions: { originalWidth: 1920, originalHeight: 1080, displayWidth: 960, displayHeight: 540 },
        filePath: 'C:/tmp/shot.png',
      },
    }

    const slimmed = stripDuplicatedMediaPayload(result) as typeof result

    expect(slimmed.file.base64).toBeUndefined()
    // Everything the CLI renderer reads must survive.
    expect(slimmed.file.type).toBe('image/png')
    expect(slimmed.file.originalSize).toBe(base64.length)
    expect(slimmed.file.dimensions).toEqual(result.file.dimensions)
    expect(slimmed.file.filePath).toBe('C:/tmp/shot.png')
    expect(slimmed.type).toBe('image')
  })

  test('halves a realistic screenshot record below the semantic budget', () => {
    // Mirrors the observed shape: the same 4.86MB payload stored twice.
    const base64 = 'A'.repeat(4_860_000)
    const record = JSON.stringify({
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] },
      toolUseResult: { type: 'image', file: { base64, type: 'image/png', dimensions: { originalWidth: 1920, originalHeight: 1080 } } },
    })
    expect(record.length).toBeGreaterThan(8 * 1024 * 1024)

    const entry = JSON.parse(record) as Record<string, unknown>
    entry.toolUseResult = stripDuplicatedMediaPayload(entry.toolUseResult)
    expect(JSON.stringify(entry).length).toBeLessThan(8 * 1024 * 1024)
    // The bytes the model is sent are untouched.
    expect((entry.message as { content: { source: { data: string } }[] }).content[0]!.source.data).toBe(base64)
  })

  test('does not mutate the object handed to hooks and telemetry', () => {
    const original = { type: 'image', file: { base64: 'payload', type: 'image/png' } }

    const slimmed = stripDuplicatedMediaPayload(original)

    expect(original.file.base64).toBe('payload')
    expect(slimmed).not.toBe(original)
    expect((slimmed as typeof original).file).not.toBe(original.file)
  })

  test('leaves results without a duplicated payload untouched', () => {
    const shell = { backgroundTaskId: 'task-1', stdout: 'ok' }
    expect(stripDuplicatedMediaPayload(shell)).toBe(shell)

    // A non-string base64 is not a duplicated payload.
    const odd = { file: { base64: null } }
    expect(stripDuplicatedMediaPayload(odd)).toBe(odd)

    // The array shape (MCP layout editor output) has no `file.base64`.
    const array = [{ type: 'text', text: 'x'.repeat(1_000_000) }]
    expect(stripDuplicatedMediaPayload(array)).toBe(array)

    expect(stripDuplicatedMediaPayload(undefined)).toBeUndefined()
    expect(stripDuplicatedMediaPayload('plain')).toBe('plain')
  })

  test('keeps AskUserQuestion and background-task fields intact', () => {
    const question = { questions: [{ question: 'Ship?' }], answers: { Ship: 'yes' } }
    expect(stripDuplicatedMediaPayload(question)).toBe(question)

    const pdf = { type: 'pdf', file: { filePath: 'C:/tmp/a.pdf', originalSize: 1000 } }
    expect(stripDuplicatedMediaPayload(pdf)).toBe(pdf)
  })
})

describe('stripped media payload still renders in the CLI transcript', () => {
  /**
   * Composition test. `stripDuplicatedMediaPayload` runs at the persist point
   * in `checkPermissionsAndCallTool`, and BOTH CLI renderers validate the
   * persisted `toolUseResult` with `FileReadTool.outputSchema.safeParse`,
   * rendering nothing when it fails:
   *   - src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx:60
   *   - src/components/messages/CollapsedReadSearchContent.tsx:95
   * The unit tests above exercise the stripper alone, which is exactly how a
   * required `base64` in the schema went unnoticed and made the read-image row
   * disappear. This test wires the two ends together.
   */
  test('the persisted result of a stripped image read passes the renderer schema', async () => {
    const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
    const base64 = 'A'.repeat(4 * 1024 * 1024)
    const produced = {
      type: 'image',
      file: {
        base64,
        type: 'image/png',
        originalSize: base64.length,
        dimensions: { originalWidth: 1536, originalHeight: 1536, displayWidth: 1536, displayHeight: 1536 },
      },
    }

    // What actually lands in the transcript.
    const persisted = stripDuplicatedMediaPayload(produced)

    const parsed = FileReadTool.outputSchema!.safeParse(persisted)
    expect(parsed.success).toBe(true)
    // And the size actually halves, which is the whole point.
    expect(JSON.stringify(persisted).length).toBeLessThan(JSON.stringify(produced).length / 2 + 1_000)
  })

  test('the persisted result of a stripped pdf read passes the renderer schema', async () => {
    const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
    const produced = { type: 'pdf', file: { filePath: 'C:/tmp/a.pdf', base64: 'B'.repeat(500_000), originalSize: 500_000 } }

    const persisted = stripDuplicatedMediaPayload(produced)

    expect(FileReadTool.outputSchema!.safeParse(persisted).success).toBe(true)
  })
})
