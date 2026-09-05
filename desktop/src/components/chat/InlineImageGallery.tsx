import { useMemo, useState } from 'react'
import { ImageGalleryModal } from './ImageGalleryModal'
import { ImageAnnotationModal } from './ImageAnnotationModal'
import { useChatStore } from '../../stores/chatStore'
import { localImageFileUrl } from '../../lib/attachmentImages'
import { extractAssistantOutputTargets } from '../../lib/assistantOutputTargets'
import { isAbsoluteLocalPath, previewFsUrl } from '../../lib/handlePreviewLink'
import { getServerBaseUrl } from '../../lib/desktopRuntime'

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i

/**
 * Extracts remote http(s) image URLs from text content.
 *
 * MCP image tools (e.g. taptap-maker) return a `previewUrl` served over https
 * alongside a local `absolutePath` that often sits outside the filesystem
 * sandbox and 403s. The remote URL is directly loadable (CSP `img-src`
 * allows `https:`), so it is surfaced as its own gallery source.
 */
export function extractRemoteImageUrls(text: string): string[] {
  const regex = /(?:^|[\s`"'(])(https?:\/\/[^\s`"')<>]+?\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico)(?:\?[^\s`"')<>]*)?)/gi
  const urls: string[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const u = match[1]!.trim()
    if (!seen.has(u)) {
      seen.add(u)
      urls.push(u)
    }
  }

  return urls
}

/**
 * Extracts local image paths that are the download sibling of a remote
 * `previewUrl` within an MCP image-tool result.
 *
 * Tools like taptap-maker return one logical image as BOTH a remote
 * `previewUrl` and a local `absolutePath`/`localPath` (the on-disk copy). The
 * local copy usually sits outside the filesystem sandbox and 403s, so if it is
 * also surfaced as a gallery source the user sees a second, broken duplicate.
 * These keys explicitly mark a path as that sibling, so their values are
 * excluded from the local-path sources whenever the remote URL is rendered.
 */
export function extractSiblingLocalPaths(text: string): Set<string> {
  const regex = /"(?:absolutePath|localPath)"\s*:\s*"([^"]+)"/gi
  const paths = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    paths.add(match[1]!.trim())
  }
  return paths
}

/**
 * Extracts absolute image file paths from text content.
 * Matches paths like /Users/.../image.png, /tmp/output.jpg, etc.
 */
export function extractImagePaths(text: string): string[] {
  // Match absolute paths ending with image extensions
  // Handles paths that may be wrapped in backticks, quotes, or standalone
  const regex = /(?:^|[\s`"'(])(\/?(?:[A-Za-z]:[\\/]|\/)[^\s`"')<>]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico))/gim
  const paths: string[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const p = match[1]!.trim()
    if (!seen.has(p) && IMAGE_EXTENSIONS.test(p)) {
      seen.add(p)
      paths.push(p)
    }
  }

  return paths
}

function fileName(filePath: string): string {
  const name = filePath.split('/').pop() || filePath
  // Remote URLs can carry a query/hash after the extension (e.g. ?token=…).
  return name.split(/[?#]/)[0] || name
}

type GalleryImage = {
  src: string
  name: string
}

type Props = {
  text: string
  /**
   * When provided, relative workspace image paths (e.g. `outputs/foo/frame.png`)
   * are also rendered inline, served via `/preview-fs/<sessionId>/...`. Absent
   * (ToolResult/ToolCall usage) keeps the legacy absolute-path-only behavior.
   */
  sessionId?: string
  workDir?: string | null
  changedFiles?: string[]
  /** ImageGen outputs already have a dedicated placeholder/result card. */
  suppressManagedGeneratedImages?: boolean
  /**
   * Render remote http(s) image URLs (e.g. an MCP tool's `previewUrl`) found in
   * the text. Off by default: assistant prose is untrusted, and auto-loading
   * arbitrary remote images there would reintroduce the tracking-pixel/loopback
   * probe risk that {@link createWorkspaceMarkdownImageResolver} deliberately
   * avoids. Tool-output surfaces opt in because that is where MCP tools return a
   * loadable preview URL alongside a sandboxed local path that often 403s.
   */
  allowRemoteImages?: boolean
}

export function InlineImageGallery({ text, sessionId, workDir, changedFiles, suppressManagedGeneratedImages = false, allowRemoteImages = false }: Props) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [annotationTarget, setAnnotationTarget] = useState<GalleryImage | null>(null)

  // Absolute paths are explicitly written out in the prose (not guessed), and the
  // turn checkpoint can't see files written via Bash or outside its tracking scope
  // — so they keep the legacy behavior and render unconditionally. changedFiles
  // only steers the relative-target extraction below, where mentions genuinely
  // need to be reconciled against what the turn actually wrote.
  const imagePaths = useMemo(
    () => extractImagePaths(text).filter(
      (imagePath) => !suppressManagedGeneratedImages || !isManagedGeneratedImagePath(imagePath),
    ),
    [suppressManagedGeneratedImages, text],
  )

  // Remote http(s) image URLs (e.g. an MCP tool's `previewUrl`) load directly —
  // they don't touch the filesystem sandbox that a sibling local `absolutePath`
  // usually 403s on — so they are surfaced as their own gallery sources. Gated
  // behind allowRemoteImages so untrusted assistant prose can't auto-load them.
  const remoteUrls = useMemo(
    () => (allowRemoteImages ? extractRemoteImageUrls(text) : []),
    [allowRemoteImages, text],
  )

  // When a remote previewUrl is rendered, its on-disk sibling (absolutePath /
  // localPath) is the SAME image — dropping it avoids a second, sandbox-403
  // duplicate tile. Only meaningful once remote URLs are actually surfaced.
  const siblingLocalPaths = useMemo(
    () => (remoteUrls.length > 0 ? extractSiblingLocalPaths(text) : new Set<string>()),
    [remoteUrls.length, text],
  )

  // An empty changedFiles only means "no TRACKED file changed" (Bash writes are
  // invisible to the checkpoint), so it is treated as "no evidence" and falls
  // back to text-only extraction instead of filtering every mention away.
  const changedFileEvidence = changedFiles !== undefined && changedFiles.length === 0 ? undefined : changedFiles

  const images = useMemo<GalleryImage[]>(() => {
    // 0. Remote URLs (rendered first) — most reliable, no sandbox involved.
    const remote: GalleryImage[] = remoteUrls.map((u) => ({ src: u, name: fileName(u) }))

    // 1. Absolute paths (legacy behavior) — served via /api/filesystem/file.
    const seenSrc = new Set(remote.map((img) => img.src))
    const absolute: GalleryImage[] = []
    for (const p of imagePaths) {
      if (siblingLocalPaths.has(p)) continue
      const src = localImageFileUrl(p)
      if (seenSrc.has(src)) continue
      seenSrc.add(src)
      absolute.push({ src, name: fileName(p) })
    }

    if (!sessionId) {
      return [...remote, ...absolute]
    }

    // 2. Relative workspace images — only when a sessionId is available so we can
    //    build a /preview-fs URL. Reuses the sandboxed target extractor instead of
    //    a bespoke relative-path regex.
    const base = getServerBaseUrl()
    const relativeTargets = extractAssistantOutputTargets(text, { workDir, changedFiles: changedFileEvidence }).filter(
      (target) => target.kind === 'image',
    )

    // Dedup: an absolute path inside the workspace can be caught by BOTH sources.
    // Skip a relative target whose basename already appears among the absolute
    // images, and also collapse duplicate relative targets by resolved src.
    const absoluteNames = new Set(absolute.map((img) => img.name))
    const relative: GalleryImage[] = []

    for (const target of relativeTargets) {
      const relPath = target.normalizedPath ?? target.href
      const name = fileName(relPath)
      if (absoluteNames.has(name)) {
        continue
      }
      const src = isAbsoluteLocalPath(relPath)
        ? localImageFileUrl(relPath)
        : previewFsUrl(base, sessionId, relPath)
      if (seenSrc.has(src)) {
        continue
      }
      seenSrc.add(src)
      relative.push({ src, name })
    }

    return [...remote, ...absolute, ...relative]
  }, [changedFileEvidence, imagePaths, remoteUrls, sessionId, siblingLocalPaths, text, workDir])

  if (images.length === 0) return null

  const saveAnnotatedImage = (dataUrl: string) => {
    if (!sessionId || !annotationTarget) return
    useChatStore.getState().queueComposerPrefill(sessionId, {
      text: '',
      mode: 'append',
      attachments: [{
        type: 'image',
        name: annotationTarget.name.replace(/(\.[^.]+)?$/, '-annotated.png'),
        data: dataUrl,
        previewUrl: dataUrl,
        mimeType: 'image/png',
      }],
    })
    setAnnotationTarget(null)
    setActiveIndex(null)
  }

  return (
    <>
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-outline)]">
          <span className="material-symbols-outlined text-[12px]">image</span>
          {images.length === 1 ? '1 image' : `${images.length} images`}
        </div>
        <div className={`grid gap-2 ${images.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {images.map((img, i) => (
            <button
              key={img.src}
              type="button"
              onClick={() => setActiveIndex(i)}
              className="group/image relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-left shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-150 hover:shadow-[var(--shadow-composer)] hover:border-[var(--color-primary-fixed-dim)]"
            >
              <img
                src={img.src}
                alt={img.name}
                loading="lazy"
                className="w-full object-cover"
                style={{ maxHeight: images.length === 1 ? 400 : 240 }}
                onError={(e) => {
                  // Hide broken images
                  (e.target as HTMLImageElement).closest('button')!.style.display = 'none'
                }}
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover/image:bg-black/20 group-hover/image:opacity-100">
                <span className="material-symbols-outlined rounded-full bg-white/90 p-2 text-[20px] text-[var(--color-text-primary)] shadow-lg">
                  fullscreen
                </span>
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2.5 pb-2 pt-6">
                <span className="text-[10px] font-medium text-white/90 drop-shadow-sm">
                  {img.name}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {activeIndex !== null && activeIndex >= 0 && (
        <ImageGalleryModal
          open={activeIndex !== null}
          images={images}
          activeIndex={activeIndex}
          onClose={() => setActiveIndex(null)}
          onSelect={setActiveIndex}
          onAnnotate={sessionId ? (image) => {
            setActiveIndex(null)
            setAnnotationTarget(image)
          } : undefined}
        />
      )}

      <ImageAnnotationModal
        open={!!annotationTarget}
        image={annotationTarget}
        onClose={() => setAnnotationTarget(null)}
        onSave={saveAnnotatedImage}
      />
    </>
  )
}

function isManagedGeneratedImagePath(imagePath: string): boolean {
  return imagePath.replaceAll('\\', '/').includes('/.claude/cc-haha/generated-images/')
}
