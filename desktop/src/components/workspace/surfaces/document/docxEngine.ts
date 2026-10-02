import type * as DocxPreview from 'docx-preview'
import { OfficeZipError, inspectOfficeZip, type OfficeZipLimits } from '@/lib/workspace/officeZipGuard'

type DocxLibrary = typeof DocxPreview

/**
 * Why a Word document could not be shown, in the terms the reader can act on.
 *
 * - `invalid`: not a .docx, damaged, or half-written by an agent that is still at it.
 * - `tooComplex`: a well-formed archive that promises to inflate to more than the page can hold.
 * - `unavailable`: docx-preview itself could not be loaded.
 */
export type DocxErrorKind = 'invalid' | 'tooComplex' | 'unavailable'

export class DocxError extends Error {
  readonly kind: DocxErrorKind
  readonly reason: unknown

  constructor(kind: DocxErrorKind, message: string, reason?: unknown) {
    super(message)
    this.name = 'DocxError'
    this.kind = kind
    this.reason = reason
  }
}

/** Where the document is drawn: its pages, and the stylesheet docx-preview writes for them. */
export type DocxRenderTarget = {
  body: HTMLElement
  /** docx-preview empties this before it writes, so give it a container of its own. */
  styles: HTMLElement
}

export type DocxEngine = {
  render(bytes: Uint8Array, target: DocxRenderTarget): Promise<void>
}

/**
 * docx-preview's options, and why each is not left to its default.
 *
 * `renderAltChunks`: Word lets a .docx carry an HTML document, and docx-preview draws it in
 * an `<iframe>` of its own, with no sandbox. Off: the document is drawn without it.
 * `useBase64URL`: pictures become `data:` URLs, the one source the frame's policy allows,
 * and there are no `blob:` URLs left behind to revoke.
 */
export const DOCX_RENDER_OPTIONS: Partial<DocxPreview.Options> = {
  className: 'docx',
  inWrapper: true,
  breakPages: true,
  renderAltChunks: false,
  useBase64URL: true,
  renderComments: false,
  renderChanges: false,
  experimental: false,
  debug: false,
}

export type DocxEngineOptions = {
  loadDocx: () => Promise<DocxLibrary>
  /** What an archive may promise to inflate to. For tests; the defaults are what the app uses. */
  zipLimits?: OfficeZipLimits
}

/**
 * The Word engine, built on docx-preview. It checks the archive's table of contents before
 * handing it over — docx-preview unpacks the whole thing in the page's own thread — and
 * turns whatever goes wrong into one of {@link DocxErrorKind}.
 */
export function createDocxEngine({ loadDocx, zipLimits }: DocxEngineOptions): DocxEngine {
  return {
    async render(bytes, target) {
      try {
        inspectOfficeZip(bytes, zipLimits)
      } catch (error) {
        if (error instanceof OfficeZipError) {
          throw new DocxError(error.reason === 'not-a-zip' ? 'invalid' : 'tooComplex', error.message, error)
        }
        throw error
      }

      let docx: DocxLibrary
      try {
        docx = await loadDocx()
      } catch (error) {
        throw new DocxError('unavailable', error instanceof Error ? error.message : String(error), error)
      }

      try {
        await docx.renderAsync(bytes, target.body, target.styles, DOCX_RENDER_OPTIONS)
      } catch (error) {
        // A package that opens as a zip but is not a document (no main part, broken XML).
        throw new DocxError('invalid', error instanceof Error ? error.message : String(error), error)
      }
    },
  }
}

/** The engine the app uses. docx-preview loads on the first Word document, not at startup. */
export const defaultDocxEngine: DocxEngine = createDocxEngine({
  loadDocx: () => import('docx-preview'),
})
