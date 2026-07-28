import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBaseUrl } from '../api/client'

vi.mock('./imageCompress', () => ({
  compressDataUrl: vi.fn(async (dataUrl: string) => dataUrl),
}))
import { browserHost } from './desktopHost/browserHost'
import {
  filesToComposerAttachments,
  getDataTransferFiles,
  pathToComposerAttachment,
} from './composerAttachments'

describe('composer attachment payloads', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
    setBaseUrl('http://127.0.0.1:3456')
  })

  it('keeps many selected desktop project files as paths instead of request-body data', () => {
    const projectRoot = '/tmp/cc-haha-issue-444-regression'
    const files = Array.from({ length: 12 }, (_, index) => (
      `${projectRoot}/assets/large-${index + 1}.bin`
    ))

    const oldInlineAttachments = files.map((filePath) => ({
      type: 'file',
      name: filePath.split('/').pop(),
      data: `data:application/octet-stream;base64,${'A'.repeat(256 * 1024)}`,
      mimeType: 'application/octet-stream',
    }))
    const oldInlinePayload = JSON.stringify({
      type: 'user_message',
      content: 'analyze these files',
      attachments: oldInlineAttachments,
    })

    const pathOnlyAttachments = files.map(pathToComposerAttachment)
    const pathOnlyPayload = JSON.stringify({
      type: 'user_message',
      content: 'analyze these files',
      attachments: pathOnlyAttachments,
    })

    expect(oldInlinePayload.length).toBeGreaterThan(3 * 1024 * 1024)
    expect(pathOnlyPayload.length).toBeLessThan(3 * 1024)
    expect(pathOnlyAttachments.every((attachment) => attachment.path && !attachment.data)).toBe(true)
  })

  it('creates safe preview URLs for native image paths with spaces', () => {
    setBaseUrl('http://127.0.0.1:4567')

    const attachment = pathToComposerAttachment('C:\\Users\\Ada Lovelace\\Pictures\\chart final.PNG')

    expect(attachment).toMatchObject({
      name: 'chart final.PNG',
      type: 'image',
      path: 'C:\\Users\\Ada Lovelace\\Pictures\\chart final.PNG',
      mimeType: 'image/png',
      previewUrl: 'http://127.0.0.1:4567/api/filesystem/file?path=C%3A%5CUsers%5CAda%20Lovelace%5CPictures%5Cchart%20final.PNG',
    })
    expect(attachment.previewUrl).not.toContain('file://')
  })

  it('keeps non-image native paths as file chips without preview URLs', () => {
    const attachment = pathToComposerAttachment('/workspace/notes.txt')

    expect(attachment).toMatchObject({
      name: 'notes.txt',
      type: 'file',
      path: '/workspace/notes.txt',
    })
    expect(attachment.previewUrl).toBeUndefined()
    expect(attachment.data).toBeUndefined()
  })

  it('keeps pasted desktop files as native path attachments across common file types', async () => {
    const nativePaths = new Map<File, string>()
    const files = [
      new File(['# Notes'], 'notes.md', { type: 'text/markdown' }),
      new File(['pdf'], 'brief.pdf', { type: 'application/pdf' }),
      new File(['docx'], 'proposal.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ]
    nativePaths.set(files[0]!, 'C:\\Users\\Nanmi\\Desktop\\notes.md')
    nativePaths.set(files[1]!, 'C:\\Users\\Nanmi\\Desktop\\brief.pdf')
    nativePaths.set(files[2]!, 'C:\\Users\\Nanmi\\Desktop\\proposal.docx')
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      files: {
        getPathForFile: file => nativePaths.get(file) ?? '',
      },
    }

    const attachments = await filesToComposerAttachments(files)

    expect(attachments.map(({ name, path, data }) => ({ name, path, data }))).toEqual([
      { name: 'notes.md', path: 'C:\\Users\\Nanmi\\Desktop\\notes.md', data: undefined },
      { name: 'brief.pdf', path: 'C:\\Users\\Nanmi\\Desktop\\brief.pdf', data: undefined },
      { name: 'proposal.docx', path: 'C:\\Users\\Nanmi\\Desktop\\proposal.docx', data: undefined },
    ])
  })

  it('keeps a mixed desktop batch when one image preview cannot be read', async () => {
    class SelectiveFileReader {
      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: (() => void) | null = null
      error: DOMException | null = null

      readAsDataURL(file: File) {
        if (file.name === 'broken.jpg') {
          this.error = new DOMException('read failed')
          this.onerror?.()
          return
        }
        this.result = 'data:image/jpeg;base64,GOOD'
        this.onload?.({} as ProgressEvent<FileReader>)
      }
    }
    vi.stubGlobal('FileReader', SelectiveFileReader)

    const broken = new File(['broken'], 'broken.jpg', { type: 'image/jpeg' })
    const good = new File(['good'], 'good.jpg', { type: 'image/jpeg' })
    const paths = new Map<File, string>([
      [broken, 'D:\\download\\broken.jpg'],
      [good, 'D:\\download\\good.jpg'],
    ])
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      files: { getPathForFile: file => paths.get(file) ?? '' },
    }

    const attachments = await filesToComposerAttachments([broken, good])

    expect(attachments).toHaveLength(2)
    expect(attachments[0]).toMatchObject({
      name: 'broken.jpg',
      path: 'D:\\download\\broken.jpg',
      previewUrl: undefined,
    })
    expect(attachments[1]).toMatchObject({
      name: 'good.jpg',
      path: 'D:\\download\\good.jpg',
      previewUrl: 'data:image/jpeg;base64,GOOD',
    })
  })

  it('uses selected desktop image bytes for preview while keeping attachments path-only', async () => {
    class ImmediateFileReader {
      result: string | ArrayBuffer | null = null
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: (() => void) | null = null
      error: DOMException | null = null

      readAsDataURL(file: Blob) {
        const mimeType = file.type || 'application/octet-stream'
        this.result = `data:${mimeType};base64,SELECTED`
        this.onload?.({} as ProgressEvent<FileReader>)
      }
    }
    vi.stubGlobal('FileReader', ImmediateFileReader)

    const nativePaths = new Map<File, string>()
    const image = new File(['jpg'], '6代码仓库.jpg', { type: 'image/jpeg' })
    const notes = new File(['# Notes'], 'notes.md', { type: 'text/markdown' })
    nativePaths.set(image, 'D:\\download\\6代码仓库.jpg')
    nativePaths.set(notes, 'D:\\download\\notes.md')
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      files: {
        getPathForFile: file => nativePaths.get(file) ?? '',
      },
    }

    const attachments = await filesToComposerAttachments([image, notes])

    expect(attachments).toEqual([
      expect.objectContaining({
        name: '6代码仓库.jpg',
        type: 'image',
        path: 'D:\\download\\6代码仓库.jpg',
        previewUrl: 'data:image/jpeg;base64,SELECTED',
      }),
      expect.objectContaining({
        name: 'notes.md',
        type: 'file',
        path: 'D:\\download\\notes.md',
        previewUrl: undefined,
      }),
    ])
    expect(attachments.every((attachment) => attachment.data === undefined)).toBe(true)
  })

  it('keeps formats the server cannot inline as file attachments', () => {
    // `type: 'image'` makes ConversationService inline the bytes as an image block,
    // which the API rejects for these media types — they stay path references.
    expect(pathToComposerAttachment('/Users/nanmi/Desktop/logo.svg').type).toBe('file')
    expect(pathToComposerAttachment('/Users/nanmi/Desktop/photo.avif').type).toBe('file')
    expect(pathToComposerAttachment('/Users/nanmi/Desktop/icon.ico').type).toBe('file')
  })

  it('reads clipboard files from DataTransfer items when the files list is empty', () => {
    const markdown = new File(['# Notes'], 'notes.md', { type: 'text/markdown' })
    const dataTransfer = {
      files: [],
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => markdown },
      ],
    } as unknown as DataTransfer

    expect(getDataTransferFiles(dataTransfer)).toEqual([markdown])
  })

  it('keeps every clipboard item when the browser files list is incomplete', () => {
    const markdown = new File(['# Notes'], 'notes.md', { type: 'text/markdown' })
    const spreadsheet = new File(['name,total'], 'budget.csv', { type: 'text/csv' })
    const dataTransfer = {
      files: [markdown],
      items: [
        { kind: 'file', getAsFile: () => markdown },
        { kind: 'file', getAsFile: () => spreadsheet },
      ],
    } as unknown as DataTransfer

    expect(getDataTransferFiles(dataTransfer)).toEqual([markdown, spreadsheet])
  })
})
