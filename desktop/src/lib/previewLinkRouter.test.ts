import { describe, expect, it } from 'vitest'
import { classifyPreviewLink } from './previewLinkRouter'

describe('classifyPreviewLink for a document the workspace can draw', () => {
  it('opens a listed document in the workspace, not the system application', () => {
    expect(classifyPreviewLink('out/thesis.pdf')).toMatchObject({ kind: 'file-preview', path: 'out/thesis.pdf' })
    expect(classifyPreviewLink('/Users/x/thesis.PDF')).toMatchObject({ kind: 'file-preview', path: '/Users/x/thesis.PDF' })
    expect(classifyPreviewLink('file:///Users/x/thesis.pdf')).toMatchObject({ kind: 'file-preview' })
  })

  it('opens a Word document in the workspace too', () => {
    expect(classifyPreviewLink('out/thesis.docx')).toMatchObject({ kind: 'file-preview', path: 'out/thesis.docx' })
    expect(classifyPreviewLink('/Users/x/Thesis.DOCX')).toMatchObject({ kind: 'file-preview' })
  })

  it.each(['out/budget.xlsx', 'out/macros.xlsm', 'out/legacy.xls', '/Users/x/Budget.XLSX'])(
    'opens the Excel workbook %s in the workspace too',
    (path) => {
      expect(classifyPreviewLink(path)).toMatchObject({ kind: 'file-preview', path })
    },
  )

  it('carries a line suffix through, as for any file', () => {
    expect(classifyPreviewLink('out/thesis.pdf:3')).toMatchObject({ kind: 'file-preview', path: 'out/thesis.pdf', line: 3 })
  })

  it('still sends formats the workspace cannot draw to the system application', () => {
    for (const path of ['reports/launch.pptx', 'reports/legacy.doc', 'exports/archive.zip', 'media/clip.mp4']) {
      expect(classifyPreviewLink(path).kind).toBe('system-file')
    }
  })
})

describe('classifyPreviewLink', () => {
  it('classifies loopback urls as browser-localhost', () => {
    expect(classifyPreviewLink('http://localhost:5173/').kind).toBe('browser-localhost')
    expect(classifyPreviewLink('http://127.0.0.1:8080/x').kind).toBe('browser-localhost')
  })
  it('classifies html file paths as browser-file', () => {
    expect(classifyPreviewLink('file:///Users/x/index.html').kind).toBe('browser-file')
    expect(classifyPreviewLink('/Users/x/page.htm').kind).toBe('browser-file')
    expect(classifyPreviewLink('./out/index.html').kind).toBe('browser-file')
  })
  it('classifies relative previewable docs as file-preview', () => {
    expect(classifyPreviewLink('docs/report.md').kind).toBe('file-preview')
    expect(classifyPreviewLink('src/app.ts').kind).toBe('file-preview')
  })
  it('routes CJK filenames instead of silently ignoring them', () => {
    // The href of an output card is a path the turn really wrote; the ASCII-only
    // prose scanner must not decide its fate. Before the split, these classified
    // as `ignored` and the card click did nothing at all.
    expect(classifyPreviewLink('README-拍摄大纲.md')).toMatchObject({ kind: 'file-preview', path: 'README-拍摄大纲.md' })
    expect(classifyPreviewLink('review-02-技术视角.md')).toMatchObject({ kind: 'file-preview', path: 'review-02-技术视角.md' })
  })
  it('sends source files to the code view even when the path is absolute', () => {
    // The code view is the only surface that can reveal a line; a browser
    // surface would just dump the source as plain text.
    expect(classifyPreviewLink('/Users/x/app.ts').kind).toBe('file-preview')
  })
  it('routes office files the workspace cannot draw, and archives, to their system application instead of the code preview', () => {
    expect(classifyPreviewLink('reports/launch.pptx')).toMatchObject({ kind: 'system-file', path: 'reports/launch.pptx' })
    expect(classifyPreviewLink('reports/legacy.doc').kind).toBe('system-file')
    expect(classifyPreviewLink('exports/archive.zip').kind).toBe('system-file')
  })
  it('reads the line suffix the system prompt asks the model to write', () => {
    expect(classifyPreviewLink('src/app.ts:42')).toMatchObject({ kind: 'file-preview', path: 'src/app.ts', line: 42 })
    expect(classifyPreviewLink('src/app.ts:42:8')).toMatchObject({ path: 'src/app.ts', line: 42, column: 8 })
    expect(classifyPreviewLink('src/app.ts#L42')).toMatchObject({ path: 'src/app.ts', line: 42 })
  })
  it('routes Windows drive paths instead of reading the drive as a URL scheme', () => {
    // `new URL('C:\\src\\app.ts')` succeeds with protocol 'c:', so before #1146
    // every path link on Windows classified as `ignored`.
    expect(classifyPreviewLink('C:\\src\\app.ts')).toMatchObject({ kind: 'file-preview', path: 'C:\\src\\app.ts' })
    expect(classifyPreviewLink('C:\\src\\app.ts:42')).toMatchObject({ path: 'C:\\src\\app.ts', line: 42 })
  })
  it('routes the extensions the old private list was missing', () => {
    expect(classifyPreviewLink('.github/workflows/release-desktop.yml:386')).toMatchObject({
      kind: 'file-preview',
      line: 386,
    })
    expect(classifyPreviewLink('scripts/windows-installer-smoke.ps1:14').kind).toBe('file-preview')
  })
  it('still ignores prose that only looks like a path', () => {
    expect(classifyPreviewLink('console.log').kind).toBe('ignored')
    expect(classifyPreviewLink('example.com').kind).toBe('ignored')
  })
  it('classifies remote http(s) as remote', () => {
    expect(classifyPreviewLink('https://example.com').kind).toBe('remote')
  })
  it('ignores anchors and empty', () => {
    expect(classifyPreviewLink('#section').kind).toBe('ignored')
    expect(classifyPreviewLink('').kind).toBe('ignored')
  })
  it('exposes a normalized path for file kinds', () => {
    expect(classifyPreviewLink('file:///Users/x/index.html').path).toBe('/Users/x/index.html')
    expect(classifyPreviewLink('docs/report.md').path).toBe('docs/report.md')
  })
})
