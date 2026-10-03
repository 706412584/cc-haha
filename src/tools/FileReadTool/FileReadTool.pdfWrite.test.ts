import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getChangedFiles } from '../../utils/attachments.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import * as pdf from '../../utils/pdf.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { FileReadTool } from './FileReadTool.js'
import { getImageCreator } from './imageProcessor.js'
import { asciiPDF } from './fixtures/asciiPDF.js'

const directories: string[] = []
const originalSimple = process.env.CLAUDE_CODE_SIMPLE
const originalCheckpoints = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
let pageCount: ReturnType<typeof spyOn>

beforeEach(() => {
  process.env.CLAUDE_CODE_SIMPLE = '1'
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
  // The fixture is a valid one-page PDF. Avoid depending on a system pdfinfo.
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-pdf-write-'))
  directories.push(root)
  const filePath = join(root, 'report.pdf')
  const original = asciiPDF('ORIGINAL')
  const replacement = asciiPDF('REPLACEMENT')
  await writeFile(filePath, original)
  return { root, filePath, original, replacement }
}

test('full PDF Read authorizes exact ASCII PDF replacement and keeps later Reads as documents', async () => {
  const { root, filePath, original, replacement } = await fixture()
  const ctx = context()
  const templatePath = join(root, 'template.txt')
  await writeFile(templatePath, replacement)
  const template = await FileReadTool.call({ file_path: templatePath }, ctx)
  expect(template.data.type).toBe('text')
  if (template.data.type !== 'text') throw new Error('Expected text template')
  expect(template.data.file.content).toBe(replacement)
  const input = { file_path: filePath, content: template.data.file.content }
  expect(await FileWriteTool.validateInput(input, ctx)).toMatchObject({ result: false, errorCode: 2 })

  const result = await FileReadTool.call({ file_path: filePath }, ctx)
  expect(result.data.type).toBe('pdf')
  expect(result.newMessages?.[0]?.message.content).toMatchObject([
    { type: 'document', source: { data: Buffer.from(original).toString('base64') } },
  ])
  expect(await FileWriteTool.validateInput(input, ctx)).toEqual({ result: true })

  // A cached PDF read must still send the document, not a text-range dedup stub.
  expect((await FileReadTool.call({ file_path: filePath }, ctx)).data.type).toBe('pdf')
  await FileWriteTool.call(input, ctx, undefined as never, { uuid: 'pdf-write-test' } as never)
  expect(await readFile(filePath)).toEqual(Buffer.from(replacement))
  const afterWrite = await FileReadTool.call({ file_path: filePath }, ctx)
  expect(afterWrite.data.type).toBe('pdf')
  if (afterWrite.data.type === 'pdf') {
    expect(Buffer.from(afterWrite.data.file.base64, 'base64')).toEqual(Buffer.from(replacement))
  }
  expect((await FileReadTool.call({ file_path: filePath }, ctx)).data.type).toBe('pdf')
  expect(await FileWriteTool.validateInput(input, context())).toMatchObject({ result: false, errorCode: 2 })
})

test('PDF authorization fits the file-state budget without retaining a binary text snapshot', async () => {
  const { filePath, replacement } = await fixture()
  const ctx = context()
  // Much smaller than the PDF payload: authorization must not be evicted just
  // because a document's base64 expansion exceeds the text-cache budget.
  ctx.readFileState = createFileStateCacheWithSizeLimit(100, 64)
  await FileReadTool.call({ file_path: filePath }, ctx)
  expect(await FileWriteTool.validateInput({ file_path: filePath, content: replacement }, ctx))
    .toEqual({ result: true })
})

test('failed PDF Read never authorizes an existing target', async () => {
  const { filePath, replacement } = await fixture()
  await writeFile(filePath, 'invalid PDF')
  const ctx = context()
  await expect(FileReadTool.call({ file_path: filePath }, ctx)).rejects.toThrow('missing %PDF- header')
  expect(ctx.readFileState.has(filePath)).toBe(false)
  expect(await FileWriteTool.validateInput({ file_path: filePath, content: replacement }, ctx))
    .toMatchObject({ result: false, errorCode: 2 })
  expect(await readFile(filePath, 'utf8')).toBe('invalid PDF')
})

test('PDF page extraction neither grants full-file Write access nor dedups against a full Read', async () => {
  const { root, filePath, original, replacement } = await fixture()
  const creator = await getImageCreator()
  const jpeg = await creator({ create: {
    width: 4, height: 3, channels: 3, background: { r: 20, g: 40, b: 60 },
  } }).jpeg().toBuffer()
  await writeFile(join(root, 'page-1.jpg'), jpeg)
  const extraction = spyOn(pdf, 'extractPDFPages').mockResolvedValue({
    success: true,
    data: { type: 'parts', file: { filePath, originalSize: Buffer.byteLength(original), outputDir: root, count: 1 } },
  })
  try {
    const ctx = context()
    const input = { file_path: filePath, content: replacement }
    expect((await FileReadTool.call({ file_path: filePath, pages: '1' }, ctx)).data.type).toBe('parts')
    expect(ctx.readFileState.has(filePath)).toBe(false)
    expect(await FileWriteTool.validateInput(input, ctx)).toMatchObject({ result: false, errorCode: 2 })

    await FileReadTool.call({ file_path: filePath }, ctx)
    expect((await FileReadTool.call({ file_path: filePath, pages: '1' }, ctx)).data.type).toBe('parts')
    expect(extraction).toHaveBeenCalledTimes(2)
    expect(await FileWriteTool.validateInput(input, ctx)).toEqual({ result: true })
  } finally {
    extraction.mockRestore()
  }
})

test('external PDF changes after Read are rejected in validation and immediately before Write', async () => {
  const { filePath, replacement } = await fixture()
  const ctx = context()
  await FileReadTool.call({ file_path: filePath }, ctx)
  const input = { file_path: filePath, content: replacement }
  expect(await FileWriteTool.validateInput(input, ctx)).toEqual({ result: true })

  const changed = asciiPDF('EXTERNAL_CHANGE')
  const later = new Date((await stat(filePath)).mtimeMs + 2000)
  await writeFile(filePath, changed)
  await utimes(filePath, later, later)
  // Text-file change attachments must not refresh PDF authorization behind
  // the model's back when there is no PDF diff to send.
  expect(await getChangedFiles(ctx)).toEqual([])
  expect(await FileWriteTool.validateInput(input, ctx)).toMatchObject({ result: false, errorCode: 3 })
  await expect(FileWriteTool.call(input, ctx, undefined as never, { uuid: 'stale-pdf-write' } as never))
    .rejects.toThrow('unexpectedly modified')
  expect(await readFile(filePath, 'utf8')).toBe(changed)

  await FileReadTool.call({ file_path: filePath }, ctx)
  expect(await FileWriteTool.validateInput(input, ctx)).toEqual({ result: true })
  await FileWriteTool.call(input, ctx, undefined as never, { uuid: 'reread-pdf-write' } as never)
  expect(await readFile(filePath)).toEqual(Buffer.from(replacement))
})

test('a PDF changed during Read is not stamped with the later unread version', async () => {
  const { filePath, replacement } = await fixture()
  const ctx = context()
  const actualRead = pdf.readPDF
  const later = new Date((await stat(filePath)).mtimeMs + 2000)
  const reading = spyOn(pdf, 'readPDF').mockImplementation(async path => {
    const result = await actualRead(path)
    await writeFile(path, asciiPDF('CHANGED_DURING_READ'))
    await utimes(path, later, later)
    return result
  })
  try {
    expect((await FileReadTool.call({ file_path: filePath }, ctx)).data.type).toBe('pdf')
    expect(await FileWriteTool.validateInput({ file_path: filePath, content: replacement }, ctx))
      .toMatchObject({ result: false, errorCode: 3 })
  } finally {
    reading.mockRestore()
  }
})
