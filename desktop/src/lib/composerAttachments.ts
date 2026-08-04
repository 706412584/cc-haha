import { getApiUrl } from '../api/client'
import { isInlineImagePath } from './attachmentImages'
import { isDesktopRuntime } from './desktopRuntime'
import { getDesktopHost } from './desktopHost'
import { compressDataUrl } from './imageCompress'

export type ComposerAttachment = {
  id: string
  name: string
  type: 'image' | 'file'
  path?: string
  mimeType?: string
  previewUrl?: string
  data?: string
  sourceFile?: File
  isDirectory?: boolean
  lineStart?: number
  lineEnd?: number
  diffSide?: 'old' | 'new'
  hunkId?: string
  note?: string
  quote?: string
}

const IMAGE_PATH_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const IMAGE_PATH_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function nextAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getPathExtension(filePath: string): string {
  const fileName = getFileNameFromPath(filePath)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : ''
}

export function isPreviewableImagePath(filePath: string): boolean {
  return IMAGE_PATH_EXTENSIONS.has(getPathExtension(filePath))
}

export function getFilesystemPreviewUrl(filePath: string): string {
  return getApiUrl(`/api/filesystem/file?path=${encodeURIComponent(filePath)}`)
}

function getImageMimeTypeForPath(filePath: string): string | undefined {
  return IMAGE_PATH_MIME_TYPES[getPathExtension(filePath)]
}

export function getFileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/g, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || filePath
}

export function pathToComposerAttachment(filePath: string): ComposerAttachment {
  const isImage = isPreviewableImagePath(filePath)
  return {
    id: nextAttachmentId(),
    // Path-only attachments still have to be classified, otherwise a pasted image
    // renders as a generic file chip instead of a preview (the gallery resolves the
    // preview from the path via the local server, so the payload stays path-only).
    type: isInlineImagePath(filePath) ? 'image' : 'file',
    name: getFileNameFromPath(filePath),
    path: filePath,
    mimeType: isImage ? getImageMimeTypeForPath(filePath) : undefined,
    previewUrl: isImage ? getFilesystemPreviewUrl(filePath) : undefined,
  }
}

export function pathsToComposerAttachments(filePaths: string[]): ComposerAttachment[] {
  return filePaths
    .filter((filePath) => typeof filePath === 'string' && filePath.length > 0)
    .map(pathToComposerAttachment)
}

export function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types ?? [])
  const items = Array.from(dataTransfer.items ?? [])
  return (
    types.includes('Files') ||
    dataTransfer.files.length > 0 ||
    items.some((item) => item.kind === 'file')
  )
}

export function getDataTransferFiles(dataTransfer: DataTransfer): File[] {
  const files = Array.from(dataTransfer.files ?? [])
  const itemFiles = Array.from(dataTransfer.items ?? []).flatMap((item) => {
    if (item.kind !== 'file') return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
  return itemFiles.length > files.length ? itemFiles : files
}

export async function dataTransferToComposerAttachments(dataTransfer: DataTransfer): Promise<ComposerAttachment[]> {
  return filesToComposerAttachments(getDataTransferFiles(dataTransfer))
}

export async function filesToComposerAttachments(files: FileList | File[]): Promise<ComposerAttachment[]> {
  const entries = Array.from(files)
  const attachments = await Promise.all(entries.map(fileToComposerAttachment))
  return attachments.filter((attachment): attachment is ComposerAttachment => !!attachment)
}

function getNativeFilePath(file: File): string | undefined {
  const path = getDesktopHost().files.getPathForFile(file)
  return path.length > 0 ? path : undefined
}

async function fileToComposerAttachment(file: File): Promise<ComposerAttachment | null> {
  const nativePath = isDesktopRuntime() ? getNativeFilePath(file) : undefined
  if (nativePath) {
    const attachment = pathToComposerAttachment(nativePath)
    if (attachment.type !== 'image') return attachment

    try {
      return {
        ...attachment,
        // The selected File is already user-authorized. A blob URL lets Chromium
        // decode it only when rendered instead of synchronously copying it to
        // Base64 and re-encoding the full image on the renderer thread.
        // Keep `data` empty: the model payload remains path-only.
        previewUrl: URL.createObjectURL(file),
      }
    } catch {
      return { ...attachment, previewUrl: undefined }
    }
  }

  const isImage = file.type.startsWith('image/')
  if (isImage && isDesktopRuntime()) {
    let previewUrl: string | undefined
    try {
      previewUrl = URL.createObjectURL(file)
    } catch {
      previewUrl = undefined
    }
    return {
      id: nextAttachmentId(),
      name: file.name,
      type: 'image',
      mimeType: file.type || undefined,
      previewUrl,
      sourceFile: file,
    }
  }

  const rawData = await readFileAsDataUrl(file)
  const data = isImage ? await compressDataUrl(rawData) : rawData
  return {
    id: nextAttachmentId(),
    name: file.name,
    type: isImage ? 'image' : 'file',
    mimeType: isImage ? 'image/jpeg' : (file.type || undefined),
    previewUrl: isImage ? data : undefined,
    data,
  }
}

export async function composerAttachmentToPayload(
  attachment: ComposerAttachment,
): Promise<Omit<ComposerAttachment, 'id' | 'previewUrl' | 'sourceFile'>> {
  const data = attachment.data ?? (
    attachment.sourceFile ? await readFileAsDataUrl(attachment.sourceFile) : undefined
  )
  return {
    type: attachment.type,
    name: attachment.name,
    path: attachment.path,
    data,
    mimeType: attachment.mimeType,
    isDirectory: attachment.isDirectory,
    lineStart: attachment.lineStart,
    lineEnd: attachment.lineEnd,
    diffSide: attachment.diffSide,
    hunkId: attachment.hunkId,
    note: attachment.note,
    quote: attachment.quote,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`))
    reader.readAsDataURL(file)
  })
}
