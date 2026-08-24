import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { getEmptyToolPermissionContext, type ToolUseContext } from '../Tool.js'
import { generateImages } from '../tools/ImageGenTool/backend.js'
import { getAttachmentsForTesting } from './attachments.js'
import {
  clearUserProvidedImages,
  isUserProvidedImage,
} from './userProvidedImages.js'

// A real 1x1 PNG: FileReadTool sniffs the header, so a stub buffer would take
// the text path and never mark the attachment as an image.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

function makeToolUseContext(): ToolUseContext {
  return {
    readFileState: new Map(),
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

let scratchDir: string | undefined

afterEach(async () => {
  clearUserProvidedImages()
  if (scratchDir) await rm(scratchDir, { recursive: true, force: true })
  scratchDir = undefined
})

describe('@-mentioned images authorize ImageEdit', () => {
  test('registers an image the user attached with @', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'at-mention-image-'))
    const imagePath = join(scratchDir, 'portrait.png')
    await writeFile(imagePath, ONE_PIXEL_PNG)

    await getAttachmentsForTesting.atMentionedFiles(
      `@${imagePath} use my headshot, leave everything else alone`,
      makeToolUseContext(),
    )

    expect(isUserProvidedImage(await realpath(imagePath))).toBe(true)
  })

  test('registers a quoted @ path, the form used for non-ASCII filenames', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'at-mention-quoted-'))
    const imagePath = join(scratchDir, '1正面.png')
    await writeFile(imagePath, ONE_PIXEL_PNG)

    await getAttachmentsForTesting.atMentionedFiles(
      `@"${imagePath}" 使用我的头像，其他的不用动`,
      makeToolUseContext(),
    )

    expect(isUserProvidedImage(await realpath(imagePath))).toBe(true)
  })

  test('does not register an @-mentioned text file', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'at-mention-text-'))
    const textPath = join(scratchDir, 'notes.txt')
    await writeFile(textPath, 'not an image')

    await getAttachmentsForTesting.atMentionedFiles(
      `@${textPath} summarize this`,
      makeToolUseContext(),
    )

    expect(isUserProvidedImage(await realpath(textPath))).toBe(false)
  })

  test('an @-mentioned image survives all the way into an ImageEdit call', async () => {
    // End-to-end over the exact sequence that used to fail: the user attaches a
    // portrait with @, then asks for an edit. Neither half is mocked, so this
    // also covers the seam between attachment handling and the tool backend.
    scratchDir = await mkdtemp(join(tmpdir(), 'at-mention-e2e-'))
    const outputDir = join(scratchDir, 'out')
    const portraitPath = join(scratchDir, '1正面.png')
    await writeFile(portraitPath, ONE_PIXEL_PNG)

    await getAttachmentsForTesting.atMentionedFiles(
      `@"${portraitPath}" 使用我的头像，其他的不用动`,
      makeToolUseContext(),
    )

    const result = await generateImages({
      prompt: 'Replace the poster subject with this portrait; keep all else',
      count: 1,
      referenced_image_paths: [portraitPath],
    }, {
      kind: 'openai_images',
      providerId: 'relay-provider',
      model: 'relay-image-model',
      baseUrl: 'https://relay.example.test/v1',
      apiKey: 'relay-secret',
    }, {
      fetchImpl: async () =>
        Response.json({ data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }] }),
      outputDir,
      // Only the @ mention can authorize this path.
      inputRootDirs: [outputDir],
    })

    expect(result.operation).toBe('edit')
    expect(result.inputImageCount).toBe(1)
  })

  test('does not register an image that was never @-mentioned', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'at-mention-bystander-'))
    const mentionedPath = join(scratchDir, 'mentioned.png')
    const bystanderPath = join(scratchDir, 'private.png')
    await writeFile(mentionedPath, ONE_PIXEL_PNG)
    await writeFile(bystanderPath, ONE_PIXEL_PNG)

    await getAttachmentsForTesting.atMentionedFiles(
      `@${mentionedPath} edit this one`,
      makeToolUseContext(),
    )

    expect(isUserProvidedImage(await realpath(mentionedPath))).toBe(true)
    // Sitting in the same directory as an attached image grants nothing.
    expect(isUserProvidedImage(await realpath(bystanderPath))).toBe(false)
  })
})
