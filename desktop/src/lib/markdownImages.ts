import { isAbsoluteLocalPath, localFileUrl, previewFsUrl } from './handlePreviewLink'

/**
 * In-memory image sources are origin-bound or inline, so they are safe to keep
 * even in untrusted assistant Markdown. Everything else (relative paths,
 * http(s) URLs) is only allowed on trusted surfaces via
 * {@link createWorkspaceMarkdownImageResolver}.
 */
export function isSafeMarkdownImageSource(value: string | null): boolean {
  if (!value) return false
  if (/^blob:/i.test(value)) return true
  return /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[a-z0-9+/=\r\n]+$/i.test(value)
}

export type WorkspaceMarkdownImageContext = {
  /** Base URL of the local server (see `getServerBaseUrl`). */
  baseUrl: string
  sessionId: string
  /** Workspace-relative path of the Markdown file being previewed. */
  filePath: string
  /** Absolute session workspace root, when known. */
  workDir?: string | null
}

function splitPathSegments(value: string): string[] {
  return value.replace(/\\/g, '/').split('/')
}

/**
 * Create an `img src` resolver for trusted, user-owned Markdown documents (the
 * workspace file preview). Untrusted assistant output must NOT get a resolver —
 * the renderer then keeps only blob:/data: sources, which blocks tracking
 * pixels and loopback probes in model-generated text.
 *
 * Resolution rules, in order:
 *   1. `http(s)://` URLs pass through untouched (CSP `img-src` decides what
 *      actually loads: `https:` plus loopback `http:`).
 *   2. Safe inline sources (`blob:`, base64 `data:image/...`) pass through.
 *   3. Any other scheme (`javascript:`, `file:`, ...) is rejected, and bare
 *      fragments (`#...`) have no image to load.
 *   4. Absolute local paths (`/Users/x.png`, `C:/x.png`) go through the
 *      `$HOME`-sandboxed `/local-file/` route.
 *   5. Relative paths resolve against the Markdown file's directory and are
 *      served workspace-scoped via `/preview-fs/<sessionId>/...`. Paths that
 *      escape the workspace root (`../..`) fall back to `/local-file/` against
 *      the session `workDir` when it is known; without it they are rejected.
 */
export function createWorkspaceMarkdownImageResolver(
  context: WorkspaceMarkdownImageContext,
): (src: string) => string | null {
  return (src: string): string | null => {
    const trimmed = src.trim()
    if (!trimmed) return null
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    if (isSafeMarkdownImageSource(trimmed)) return trimmed
    // Fragments-only refs and any remaining scheme (DOMPurify already strips
    // the dangerous ones; this is defense in depth) cannot be local files.
    if (trimmed.startsWith('#')) return null
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null

    // A query string or fragment on a local path is meaningless to the file
    // server — and would otherwise land inside the last encoded path segment.
    const withoutSuffix = trimmed.split('#')[0]!.split('?')[0]!
    let localPath = withoutSuffix
    try {
      localPath = decodeURIComponent(withoutSuffix)
    } catch {
      // Keep the raw path; a malformed escape simply 404s on the server.
    }

    if (isAbsoluteLocalPath(localPath)) {
      return localFileUrl(context.baseUrl, localPath)
    }

    const mdDir = splitPathSegments(context.filePath).slice(0, -1)
    const stack: string[] = []
    let escapes = 0
    for (const segment of [...mdDir, ...splitPathSegments(localPath)]) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (stack.length > 0) stack.pop()
        else escapes += 1
        continue
      }
      stack.push(segment)
    }

    if (escapes === 0) {
      return previewFsUrl(context.baseUrl, context.sessionId, stack.join('/'))
    }

    if (!context.workDir) return null
    const workDirSegments = splitPathSegments(context.workDir).filter(Boolean)
    const absolute = workDirSegments.slice(0, Math.max(0, workDirSegments.length - escapes))
    absolute.push(...stack)
    const isWindowsDrive = /^[a-zA-Z]:$/.test(absolute[0] ?? '')
    return localFileUrl(context.baseUrl, isWindowsDrive ? absolute.join('/') : `/${absolute.join('/')}`)
  }
}
