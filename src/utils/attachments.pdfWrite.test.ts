import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../Tool.js'
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js'
import { asciiPDF } from '../tools/FileReadTool/fixtures/asciiPDF.js'
import { FileWriteTool } from '../tools/FileWriteTool/FileWriteTool.js'
import { getChangedFiles } from './attachments.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import * as pdf from './pdf.js'

const directories: string[] = []
const originalSimple = process.env.CLAUDE_CODE_SIMPLE
const originalCheckpoints = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
let pageCount: ReturnType<typeof spyOn>

beforeEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
  pageCount = spyOn(pdf, 'getPDFPageCount').mockResolvedValue(1)
})

afterEach(async () => {
  pageCount.mockRestore()
  for (const [name, value] of [
    ['CLAUDE_CODE_SIMPLE', originalSimple],
    ['CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING', originalCheckpoints],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function context(): ToolUseContext {
  return {
    readFileState: createFileStateCacheWithSizeLimit(100),
    abortController: new AbortController(),
    updateFileHistoryState: () => {},
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
  } as unknown as ToolUseContext
}

for (const extension of ['pdf', 'PDF']) {
  test(`automatic change checks after Write do not authorize an unseen ${extension} version`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-pdf-attachments-'))
    directories.push(root)
    const filePath = join(root, `report.${extension}`)
    await writeFile(filePath, asciiPDF('ORIGINAL'))
    const ctx = context()
    await FileReadTool.call({ file_path: filePath }, ctx)
    const input = { file_path: filePath, content: asciiPDF('REPLACEMENT') }
    expect(await FileWriteTool.validateInput(input, ctx)).toEqual({ result: true })
    await FileWriteTool.call(input, ctx, undefined as never, { uuid: 'pdf-attachment-write' } as never)

    const changed = asciiPDF('EXTERNAL_CHANGE')
    const later = new Date((await stat(filePath)).mtimeMs + 2000)
    await writeFile(filePath, changed)
    await utimes(filePath, later, later)
    expect(await getChangedFiles(ctx)).toEqual([])
    expect(await FileWriteTool.validateInput(input, ctx)).toMatchObject({ result: false, errorCode: 3 })
    await expect(FileWriteTool.call(input, ctx, undefined as never, { uuid: 'unseen-pdf-write' } as never))
      .rejects.toThrow('unexpectedly modified')
    expect(await readFile(filePath, 'utf8')).toBe(changed)

    await FileReadTool.call({ file_path: filePath }, ctx)
    expect(await FileWriteTool.validateInput(input, ctx)).toEqual({ result: true })
    await FileWriteTool.call(input, ctx, undefined as never, { uuid: 'reread-pdf-attachment-write' } as never)
    expect(await readFile(filePath, 'utf8')).toBe(input.content)
  })
}

test('automatic change checks still deliver external text changes after Write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-text-attachments-'))
  directories.push(root)
  const filePath = join(root, 'report.txt')
  const ctx = context()
  await FileWriteTool.call({ file_path: filePath, content: 'ORIGINAL\n' }, ctx, undefined as never, { uuid: 'text-attachment-write' } as never)
  const later = new Date((await stat(filePath)).mtimeMs + 2000)
  await writeFile(filePath, 'EXTERNAL_CHANGE\n')
  await utimes(filePath, later, later)
  const attachments = await getChangedFiles(ctx)
  expect(attachments).toMatchObject([{ type: 'edited_text_file', filename: filePath }])
  expect(JSON.stringify(attachments)).toContain('EXTERNAL_CHANGE')
})
