import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  getGeneratedImagesRootDir,
  isGeneratedImagePath,
} from '../../utils/generatedImages.js'
import { normalizeAttachmentForAPI } from '../../utils/messages.js'
import { FileReadTool } from './FileReadTool.js'

// A valid 1x1 RGBA PNG (complete IHDR/IDAT/IEND chunks — passes the tool's
// magic-byte + chunk-envelope validation, unlike a truncated signature).
const ONE_BY_ONE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='

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
let priorConfigDir: string | undefined
let priorEmbedFlag: string | undefined

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path =>
      rm(path, { recursive: true, force: true }),
    ),
  )
  if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = priorConfigDir
  if (priorEmbedFlag === undefined) delete process.env.CLAUDE_READ_EMBED_GENERATED_IMAGES
  else process.env.CLAUDE_READ_EMBED_GENERATED_IMAGES = priorEmbedFlag
})

async function makeConfigRoot(): Promise<string> {
  priorConfigDir = process.env.CLAUDE_CONFIG_DIR
  priorEmbedFlag = process.env.CLAUDE_READ_EMBED_GENERATED_IMAGES
  const root = await mkdtemp(join(tmpdir(), 'cc-haha-genimg-'))
  temporaryDirectories.push(root)
  process.env.CLAUDE_CONFIG_DIR = join(root, 'cfg')
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  return root
}

async function writeGeneratedImage(sessionId = 'sid'): Promise<string> {
  const dir = join(getGeneratedImagesRootDir(), sessionId)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, 'out.png')
  await writeFile(filePath, Buffer.from(ONE_BY_ONE_PNG, 'base64'))
  return filePath
}

describe('isGeneratedImagePath', () => {
  test('accepts a path inside the generated-images root, rejects outside and traversal', async () => {
    await makeConfigRoot()
    const root = getGeneratedImagesRootDir()

    expect(isGeneratedImagePath(join(root, 'sid', 'out.png'))).toBe(true)
    // The root itself is not "inside" it.
    expect(isGeneratedImagePath(root)).toBe(false)
    // A sibling directory sharing a prefix must not match.
    expect(isGeneratedImagePath(`${root}-evil/out.png`)).toBe(false)
    // Traversal back out of the root is rejected.
    expect(isGeneratedImagePath(join(root, '..', 'elsewhere', 'out.png'))).toBe(false)
    // An unrelated absolute path is rejected.
    expect(isGeneratedImagePath(join(tmpdir(), 'shots', 'shot.png'))).toBe(false)
    // A direct child literally named "..foo.png" is still inside the root.
    expect(isGeneratedImagePath(join(root, '..foo.png'))).toBe(true)
  })
})

describe('normalizeAttachmentForAPI for a generated-image @-mention', () => {
  test('emits a tool_use + string tool_result reference, not an unknown-attachment drop', async () => {
    await makeConfigRoot()
    const filePath = await writeGeneratedImage()
    const result = await FileReadTool.call({ file_path: filePath }, makeToolUseContext())
    expect(result.data.type).toBe('generated_image_ref')

    const messages = normalizeAttachmentForAPI({
      type: 'file',
      filename: filePath,
      content: result.data,
      // biome-ignore lint/suspicious/noExplicitAny: minimal FileAttachment for this path
    } as any)

    // Must produce the tool_use + tool_result pair (not an empty drop).
    expect(messages.length).toBeGreaterThanOrEqual(2)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain('not re-embedded')
    expect(serialized).not.toContain('base64')
  })
})

describe('FileReadTool generated-image reference', () => {
  test('reads a generated image as a text reference, not an embedded base64 block', async () => {
    await makeConfigRoot()
    const filePath = await writeGeneratedImage()

    const result = await FileReadTool.call({ file_path: filePath }, makeToolUseContext())

    expect(result.data.type).toBe('generated_image_ref')

    const block = FileReadTool.mapToolResultToToolResultBlockParam(
      result.data,
      'read-generated',
    )
    // The model-facing content must be a plain string with no image bytes.
    expect(typeof block.content).toBe('string')
    expect(block.content).toContain(filePath)
    expect(block.content).toContain('not re-embedded')
    expect(JSON.stringify(block)).not.toContain('base64')
  })

  test('a normal image outside the generated-images root still embeds base64', async () => {
    const root = await makeConfigRoot()
    const dir = join(root, 'shots')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, 'shot.png')
    await writeFile(filePath, Buffer.from(ONE_BY_ONE_PNG, 'base64'))

    const result = await FileReadTool.call({ file_path: filePath }, makeToolUseContext())

    expect(result.data.type).toBe('image')

    const block = FileReadTool.mapToolResultToToolResultBlockParam(result.data, 'read-shot')
    expect(Array.isArray(block.content)).toBe(true)
    const blocks = block.content as Array<{ type: string; source?: { type?: string } }>
    expect(blocks[0]?.type).toBe('image')
    expect(blocks[0]?.source?.type).toBe('base64')
  })

  test('CLAUDE_READ_EMBED_GENERATED_IMAGES=1 restores the base64 read for generated images', async () => {
    await makeConfigRoot()
    process.env.CLAUDE_READ_EMBED_GENERATED_IMAGES = '1'
    const filePath = await writeGeneratedImage()

    const result = await FileReadTool.call({ file_path: filePath }, makeToolUseContext())

    expect(result.data.type).toBe('image')
  })
})
