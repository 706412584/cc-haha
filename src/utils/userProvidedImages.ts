/**
 * Session-scoped registry of images the user explicitly handed to this
 * conversation by naming them — currently `@`-mentioned image files.
 *
 * ImageEdit uploads raw bytes to a third-party image API, so it refuses
 * arbitrary filesystem paths (see ImageGenTool/backend.ts). Staged uploads,
 * pasted screenshots, and generated images all live under known per-session
 * directories and are trusted by location. An `@`-mentioned file keeps its
 * original path anywhere on disk, so it is recorded here instead: the
 * authorization is the user naming the file, not the path.
 *
 * Paths the model discovered on its own — a Glob hit, a path scraped out of
 * source code, a plain FileRead — are deliberately NOT registered.
 */
import { realpath } from 'fs/promises'

const MAX_TRACKED_IMAGES = 200

// Insertion-ordered, so the oldest entry is always the first key.
const authorizedImagePaths = new Set<string>()

/**
 * Record an image the user explicitly named. Resolves symlinks so the stored
 * key matches what ImageEdit checks after its own realpath() call.
 */
export async function registerUserProvidedImage(path: string): Promise<void> {
  const resolvedPath = await realpath(path).catch(() => null)
  if (!resolvedPath) return
  // Re-adding would keep the original insertion position, which would make an
  // actively reused image look stale to the eviction pass below.
  authorizedImagePaths.delete(resolvedPath)
  while (authorizedImagePaths.size >= MAX_TRACKED_IMAGES) {
    const oldest = authorizedImagePaths.values().next().value
    if (oldest === undefined) break
    authorizedImagePaths.delete(oldest)
  }
  authorizedImagePaths.add(resolvedPath)
}

/**
 * Whether the user named this image earlier in the session. Takes an
 * already-resolved path — callers must realpath() before asking.
 */
export function isUserProvidedImage(resolvedPath: string): boolean {
  return authorizedImagePaths.has(resolvedPath)
}

export function clearUserProvidedImages(): void {
  authorizedImagePaths.clear()
}
