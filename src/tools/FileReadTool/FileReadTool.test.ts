import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDF_MAX_PAGES_PER_READ } from '../../constants/apiLimits.js'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileReadTool } from './FileReadTool.js'

function makeToolUseContext(): ToolUseContext {
  return {
    readFileState: new Map(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path =>
      rm(path, { recursive: true, force: true }),
    ),
  )
})

describe('FileReadTool pages validation', () => {
  test('ignores invalid PDF pages values for non-PDF files', async () => {
    const context = makeToolUseContext()

    await expect(
      FileReadTool.validateInput(
        { file_path: '/tmp/screenshot.png', pages: '0' },
        context,
      ),
    ).resolves.toEqual({ result: true })

    await expect(
      FileReadTool.validateInput(
        { file_path: '/tmp/example.ts', pages: '' },
        context,
      ),
    ).resolves.toEqual({ result: true })

    await expect(
      FileReadTool.validateInput(
        { file_path: 'C:\\tmp\\SCREENSHOT.PNG', pages: '0' },
        context,
      ),
    ).resolves.toEqual({ result: true })
  })

  test('keeps PDF pages validation strict', async () => {
    const context = makeToolUseContext()

    await expect(
      FileReadTool.validateInput(
        { file_path: '/tmp/document.pdf', pages: '0' },
        context,
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 7,
    })

    await expect(
      FileReadTool.validateInput(
        {
          file_path: '/tmp/document.pdf',
          pages: `1-${PDF_MAX_PAGES_PER_READ + 1}`,
        },
        context,
      ),
    ).resolves.toMatchObject({
      result: false,
      errorCode: 8,
    })
  })
})

describe('FileReadTool Windows text fidelity', () => {
  test('preserves Unicode paths and literal tabs in model-facing output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-haha-read-'))
    temporaryDirectories.push(root)
    const directory = join(root, '中文目录')
    const filePath = join(directory, 'Tab 样例.txt')
    const content = '\t\t中文目标\n    空格目标\n'
    await mkdir(directory)
    await writeFile(filePath, content, 'utf8')

    const result = await FileReadTool.call(
      { file_path: filePath },
      makeToolUseContext(),
    )

    expect(result.data.type).toBe('text')
    if (result.data.type !== 'text') return
    expect(result.data.file.filePath).toBe(filePath)
    expect(result.data.file.content).toContain('\t\t中文目标')

    const block = FileReadTool.mapToolResultToToolResultBlockParam(
      result.data,
      'read-tabs',
    )
    expect(block.content).toContain('1\t\t\t中文目标')
  })
})
