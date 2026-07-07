import { describe, expect, test } from 'bun:test'
import { PDF_MAX_PAGES_PER_READ } from '../../constants/apiLimits.js'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { FileReadTool } from './FileReadTool.js'

function makeToolUseContext(): ToolUseContext {
  return {
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

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
