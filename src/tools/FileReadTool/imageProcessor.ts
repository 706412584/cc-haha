import type { Buffer } from 'buffer'
import { createRequire } from 'node:module'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { errorMessage } from '../../utils/errors.js'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number; lossless?: boolean }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

export function resetImageProcessorForTests(): void {
  imageProcessorModule = null
  imageCreatorModule = null
}

export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  if (isInBundledMode()) {
    // Try to load the native image processor first
    try {
      // Use the native image processor module
      const imageProcessor = await import('image-processor-napi')
      const sharp = imageProcessor.sharp || imageProcessor.default
      imageProcessorModule = { default: sharp }
      return sharp
    } catch (error) {
      throw new Error(
        `Native image processor module not available in bundled mode: ${errorMessage(error)}`,
      )
    }
  }

  // Use sharp for non-bundled builds.
  // Single structural cast: our SharpFunction is a subset of sharp's actual type surface.
  const imported = await loadSharp()
  const sharp = unwrapDefault(imported)
  imageProcessorModule = { default: sharp }
  return sharp
}

/**
 * Get image creator for generating new images from scratch.
 * Note: image-processor-napi doesn't support image creation,
 * so this always uses sharp directly.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  const imported = await loadSharp()
  const sharp = unwrapDefault(imported)
  imageCreatorModule = { default: sharp }
  return sharp
}

async function loadSharp(): Promise<MaybeDefault<SharpFunction & SharpCreator>> {
  // External imports in a compiled Bun executable otherwise resolve from the
  // caller's project. The desktop ships sharp beside the executable's ancestors
  // in app.asar.unpacked/node_modules, outside Electron's virtual ASAR filesystem.
  if (isInBundledMode() || import.meta.url.includes('/$bunfs/') || import.meta.url.includes('/~BUN/')) {
    return createRequire(process.execPath)('sharp')
  }
  return await import('sharp') as unknown as MaybeDefault<SharpFunction & SharpCreator>
}

// Dynamic import shape varies by module interop mode — ESM yields { default: fn }, CJS yields fn directly.
type MaybeDefault<T> = T | { default: T }

function unwrapDefault<T extends (...args: never[]) => unknown>(
  mod: MaybeDefault<T>,
): T {
  return typeof mod === 'function' ? mod : mod.default
}
