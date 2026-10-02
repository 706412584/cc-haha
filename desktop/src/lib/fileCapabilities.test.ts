import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_DOCUMENT_EXTENSIONS,
  fileExtension,
  isEditorOpenableFile,
  isGeneratedArtifactFile,
  isOutputResourceFile,
  isWorkspaceDocumentFile,
  isWorkspacePreviewableFile,
} from './fileCapabilities'

describe('the workspace document gate', () => {
  it('ships viewers for PDF, Word and Excel: the real list routes them, with no test double standing in', () => {
    // This pins what users get. A format joins the list when its viewer lands, and the
    // server-side parity test refuses one that has no viewer.
    expect([...WORKSPACE_DOCUMENT_EXTENSIONS].sort()).toEqual(['docx', 'pdf', 'xls', 'xlsm', 'xlsx'])
  })

  it('previews a listed document in the workspace, whatever the case of its extension', () => {
    expect(isWorkspaceDocumentFile('out/thesis.pdf')).toBe(true)
    expect(isWorkspaceDocumentFile('out/THESIS.PDF')).toBe(true)
    expect(isWorkspacePreviewableFile('out/thesis.pdf')).toBe(true)
  })

  it('still keeps a document away from code editors: rendering it is not editing it', () => {
    // A `.pdf` opened in PyCharm is not a thing anyone asked for, even now that
    // the panel can draw it. The editor gate must not follow the preview gate.
    expect(isEditorOpenableFile('out/thesis.pdf')).toBe(false)
  })

  it('leaves formats the workspace cannot draw with the system application', () => {
    for (const path of ['deck.pptx', 'legacy.doc', 'archive.zip', 'song.mp3', 'clip.mp4', 'book.pages']) {
      expect(isWorkspaceDocumentFile(path)).toBe(false)
      expect(isWorkspacePreviewableFile(path)).toBe(false)
      expect(isEditorOpenableFile(path)).toBe(false)
    }
  })

  it('does not disturb what was previewable before: source, markdown, images, extensionless files', () => {
    for (const path of ['src/app.ts', 'README.md', 'logo.png', 'Makefile', 'notes.txt']) {
      expect(isWorkspacePreviewableFile(path)).toBe(true)
    }
    for (const path of ['src/app.ts', 'logo.png', 'notes.txt']) {
      expect(isWorkspaceDocumentFile(path)).toBe(false)
    }
  })

  it('reads the extension through a line suffix, like every other path helper here', () => {
    expect(fileExtension('out/thesis.pdf:12')).toBe('pdf')
    expect(isWorkspaceDocumentFile('out/thesis.pdf:12')).toBe(true)
  })

  it('still shows a produced document among the turn outputs', () => {
    expect(isGeneratedArtifactFile('out/thesis.pdf')).toBe(true)
    expect(isOutputResourceFile('out/thesis.pdf')).toBe(true)
  })

  it('holds only extensions the editor gate refuses, so previewing a document never opens an IDE menu for it', () => {
    for (const extension of WORKSPACE_DOCUMENT_EXTENSIONS) {
      expect(isEditorOpenableFile(`file.${extension}`)).toBe(false)
    }
  })
})
