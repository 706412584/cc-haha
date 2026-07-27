import type { DesktopHost } from '../../lib/desktopHost/types'
import { detectPetSheetShape, normalizePetSheetToAtlas } from './petAtlasNormalize'

/**
 * Guided import: the user picks a plain action sheet, we normalize it into the v2
 * atlas grid, then hand the finished bytes back to the main process. Authors never
 * have to produce a pixel-exact 1536x2288 file themselves.
 */

/** Mirrors the main process cap so an oversized atlas fails before crossing IPC. */
const MAX_ATLAS_BYTES = 8 * 1024 * 1024

/**
 * A sheet exported without an alpha channel renders as a solid rectangle on the
 * desktop. Real transparent artwork leaves far more than this share of the atlas
 * empty (the built-in pets sit near 78%), so anything below it is a flattened
 * background rather than a deliberately dense drawing.
 */
const MIN_TRANSPARENT_RATIO = 0.05

export type PetSheetImportInput = {
  slug: string
  displayName: string
  description: string
  dialogTitle?: string
  dialogFilterName?: string
}

export type PetSheetImportOutcome =
  | { status: 'cancelled' }
  | { status: 'created', id: string }
  | { status: 'error', errorCode: string }

function transparentPixelRatio(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 1
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let transparent = 0
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] === 0) transparent += 1
  }
  return transparent / (data.length / 4)
}

function canvasToBytes(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null)
          return
        }
        blob.arrayBuffer().then(
          buffer => resolve(new Uint8Array(buffer)),
          () => resolve(null),
        )
      },
      type,
      quality,
    )
  })
}

/**
 * Encodes the atlas, falling back to WebP when a lossless PNG would exceed the
 * package size cap. Detailed artwork can push a 1536x2288 PNG past 8 MB.
 */
async function encodeAtlas(
  canvas: HTMLCanvasElement,
): Promise<{ atlasData: Uint8Array, mimeType: 'image/png' | 'image/webp' } | null> {
  const png = await canvasToBytes(canvas, 'image/png')
  if (png && png.byteLength <= MAX_ATLAS_BYTES) return { atlasData: png, mimeType: 'image/png' }
  const webp = await canvasToBytes(canvas, 'image/webp', 0.95)
  if (webp && webp.byteLength <= MAX_ATLAS_BYTES) return { atlasData: webp, mimeType: 'image/webp' }
  return null
}

export async function importPetFromActionSheet(
  host: DesktopHost,
  input: PetSheetImportInput,
): Promise<PetSheetImportOutcome> {
  const picked = await host.pets.pickSourceSheet({
    dialogTitle: input.dialogTitle,
    dialogFilterName: input.dialogFilterName,
  })
  if (!picked) return { status: 'cancelled' }
  if ('errorCode' in picked) return { status: 'error', errorCode: picked.errorCode }

  const shape = detectPetSheetShape(picked.width, picked.height)

  // An already-exact atlas is installed byte-for-byte; re-slicing it would only
  // resample finished artwork.
  if (shape.passthrough) {
    const result = await host.pets.createFromAtlasBytes({
      slug: input.slug,
      displayName: input.displayName,
      description: input.description,
      atlasData: picked.bytes,
      mimeType: picked.mimeType,
    })
    if (!result) return { status: 'cancelled' }
    return 'id' in result
      ? { status: 'created', id: result.id }
      : { status: 'error', errorCode: result.errorCode }
  }

  // Copy into a plain ArrayBuffer: the bytes arrive over IPC and their backing
  // buffer is not guaranteed to be a transferable BlobPart.
  const sourceBuffer = new ArrayBuffer(picked.bytes.byteLength)
  new Uint8Array(sourceBuffer).set(picked.bytes)

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([sourceBuffer], { type: picked.mimeType }))
  } catch {
    return { status: 'error', errorCode: 'invalid-image' }
  }

  let atlas: HTMLCanvasElement
  try {
    atlas = normalizePetSheetToAtlas(bitmap, bitmap.width, bitmap.height, {
      sourceRows: shape.sourceRows,
    })
  } catch {
    return { status: 'error', errorCode: 'invalid-image' }
  } finally {
    bitmap.close()
  }

  if (transparentPixelRatio(atlas) < MIN_TRANSPARENT_RATIO) {
    return { status: 'error', errorCode: 'opaque-background' }
  }

  const encoded = await encodeAtlas(atlas)
  if (!encoded) return { status: 'error', errorCode: 'image-too-large' }

  const result = await host.pets.createFromAtlasBytes({
    slug: input.slug,
    displayName: input.displayName,
    description: input.description,
    atlasData: encoded.atlasData,
    mimeType: encoded.mimeType,
  })
  if (!result) return { status: 'cancelled' }
  return 'id' in result
    ? { status: 'created', id: result.id }
    : { status: 'error', errorCode: result.errorCode }
}
