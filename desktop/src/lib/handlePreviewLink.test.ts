import { describe, expect, it, vi } from 'vitest'
import {
  handlePreviewLink,
  isAbsoluteLocalPath,
  isRootedLocalPath,
  localFileUrl,
  previewFsUrl,
  type PreviewLinkDeps,
} from './handlePreviewLink'

function makeDeps(overrides?: Partial<PreviewLinkDeps>): PreviewLinkDeps {
  return {
    sessionId: 's1',
    serverBaseUrl: 'http://127.0.0.1:8787',
    openBrowser: vi.fn(),
    openFilePreview: vi.fn(),
    openSystemFile: vi.fn(),
    openExternal: vi.fn(),
    ...overrides,
  }
}

describe('handlePreviewLink', () => {
  it.each([
    ['C:\\Users\\me\\page.htm', 'local-file/C%3A/Users/me/page.htm'],
    ['~/Desktop/发布清单.htm', 'local-file/~/Desktop/%E5%8F%91%E5%B8%83%E6%B8%85%E5%8D%95.htm'],
    ['./out/page.htm', 'preview-fs/s1/./out/page.htm'],
  ])('keeps browser routing correct for %s', (filePath, route) => {
    const deps = makeDeps()
    expect(handlePreviewLink(filePath, deps)).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith('s1', `http://127.0.0.1:8787/${route}`)
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('preserves home-relative source reveal and system-document routing', () => {
    const deps = makeDeps()
    expect(handlePreviewLink('~/src/app.ts:42:8', deps)).toBe(true)
    expect(deps.openFilePreview).toHaveBeenCalledWith('s1', '~/src/app.ts', { line: 42, column: 8 })
    expect(handlePreviewLink('~/Desktop/brief.pptx', deps)).toBe(true)
    expect(deps.openSystemFile).toHaveBeenCalledWith('~/Desktop/brief.pptx')
    expect(deps.openBrowser).not.toHaveBeenCalled()
  })

  it.each(['~/Desktop/checklist.html', '~\\Desktop\\checklist.html'])(
    'routes home-relative HTML %s through local-file', (filePath) => {
      const deps = makeDeps()
      expect(handlePreviewLink(filePath, deps)).toBe(true)
      expect(deps.openBrowser).toHaveBeenCalledWith(
        's1', 'http://127.0.0.1:8787/local-file/~/Desktop/checklist.html',
      )
      expect(deps.openFilePreview).not.toHaveBeenCalled()
    },
  )

  it('routes loopback urls to openBrowser with the url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('http://localhost:5173/', deps)
    expect(handled).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith('s1', 'http://localhost:5173/')
    expect(deps.openFilePreview).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('routes absolute html file paths to openBrowser with the local-file url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('/Users/x/index.html', deps)
    expect(handled).toBe(true)
    // Absolute paths may live outside the session workspace, so they go through
    // the $HOME-sandboxed /local-file route, NOT /preview-fs.
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/local-file/Users/x/index.html',
    )
    expect(deps.openFilePreview).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('routes file:// urls to openBrowser with the local-file url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('file:///Users/x/page.html', deps)
    expect(handled).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/local-file/Users/x/page.html',
    )
  })

  it('routes a built relative .html file to openBrowser with the preview-fs (workspace) url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('out/index.html', deps)
    expect(handled).toBe(true)
    // Relative → stays workspace-scoped via /preview-fs.
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/preview-fs/s1/out/index.html',
    )
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('routes generated *_files index.html to openBrowser with the preview-fs url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('66estmutl_files/index.html', deps)
    expect(handled).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/preview-fs/s1/66estmutl_files/index.html',
    )
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('routes a hand-authored single-page index.html to the static browser preview', () => {
    // Without change-set context a bare index.html is assumed to be a standalone
    // static page (the common "make me a todo page" output), so it renders in the
    // in-app browser rather than dropping the user into the source view.
    const deps = makeDeps()
    const handled = handlePreviewLink('todo-app/index.html', deps)
    expect(handled).toBe(true)
    expect(deps.openBrowser).toHaveBeenCalledWith(
      's1',
      'http://127.0.0.1:8787/preview-fs/s1/todo-app/index.html',
    )
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('routes relative previewable docs to openFilePreview with the relative path', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('docs/report.md', deps)
    expect(handled).toBe(true)
    expect(deps.openFilePreview).toHaveBeenCalledWith('s1', 'docs/report.md', undefined)
    expect(deps.openBrowser).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('passes the line suffix through as a reveal target', () => {
    // The `file_path:line_number` contract from src/constants/prompts.ts, end to
    // end: the suffix has to survive classification and reach the code view.
    const deps = makeDeps()
    expect(handlePreviewLink('src/app.ts:42', deps)).toBe(true)
    expect(deps.openFilePreview).toHaveBeenCalledWith('s1', 'src/app.ts', { line: 42 })

    const withColumn = makeDeps()
    handlePreviewLink('src/app.ts:42:8', withColumn)
    expect(withColumn.openFilePreview).toHaveBeenCalledWith('s1', 'src/app.ts', { line: 42, column: 8 })
  })

  it('routes an office file the workspace cannot draw to the system opener instead of the workspace preview', () => {
    const deps = makeDeps()

    expect(handlePreviewLink('reports/brief.pptx', deps)).toBe(true)
    expect(deps.openSystemFile).toHaveBeenCalledWith('reports/brief.pptx')
    expect(deps.openFilePreview).not.toHaveBeenCalled()
    expect(deps.openBrowser).not.toHaveBeenCalled()
  })

  it('routes a Word document to the workspace preview, which can draw it', () => {
    const deps = makeDeps()

    expect(handlePreviewLink('reports/brief.docx', deps)).toBe(true)
    expect(deps.openFilePreview).toHaveBeenCalledWith('s1', 'reports/brief.docx', undefined)
    expect(deps.openSystemFile).not.toHaveBeenCalled()
  })

  it.each(['reports/budget.xlsx', 'reports/legacy.xls'])('routes an Excel workbook (%s) to the workspace preview as well', (path) => {
    const deps = makeDeps()

    expect(handlePreviewLink(path, deps)).toBe(true)
    expect(deps.openFilePreview).toHaveBeenCalledWith('s1', path, undefined)
    expect(deps.openSystemFile).not.toHaveBeenCalled()
  })

  it('routes remote http(s) to openExternal with the url', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('https://example.com/', deps)
    expect(handled).toBe(true)
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.com/')
    expect(deps.openBrowser).not.toHaveBeenCalled()
    expect(deps.openFilePreview).not.toHaveBeenCalled()
  })

  it('returns false for ignored links and calls no deps', () => {
    const deps = makeDeps()
    const handled = handlePreviewLink('#x', deps)
    expect(handled).toBe(false)
    expect(deps.openBrowser).not.toHaveBeenCalled()
    expect(deps.openFilePreview).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })
})

describe('isAbsoluteLocalPath', () => {
  it('treats POSIX leading-slash paths as absolute', () => {
    expect(isAbsoluteLocalPath('/Users/x/page.html')).toBe(true)
  })
  it('treats Windows drive paths as absolute (both slash styles)', () => {
    expect(isAbsoluteLocalPath('C:\\Users\\x\\page.html')).toBe(true)
    expect(isAbsoluteLocalPath('C:/Users/x/page.html')).toBe(true)
  })
  it('treats relative paths as not absolute', () => {
    expect(isAbsoluteLocalPath('out/index.html')).toBe(false)
    expect(isAbsoluteLocalPath('./page.html')).toBe(false)
  })
})

describe('isRootedLocalPath', () => {
  it.each(['~', '~/Desktop/page.html', '~\\Desktop\\page.html', '/tmp/page.html', 'C:\\temp\\page.html'])(
    'recognizes rooted path %s', (filePath) => expect(isRootedLocalPath(filePath)).toBe(true),
  )
  it.each(['~other/page.html', './~/page.html', 'out/page.html', 'C:page.html'])(
    'does not expand relative or other-user path %s', (filePath) => expect(isRootedLocalPath(filePath)).toBe(false),
  )
})

describe('localFileUrl', () => {
  it('appends a POSIX absolute path after /local-file, preserving slashes', () => {
    expect(localFileUrl('http://127.0.0.1:8787', '/Users/x/page.html')).toBe(
      'http://127.0.0.1:8787/local-file/Users/x/page.html',
    )
  })
  it('encodes spaces/unicode per segment but keeps separators', () => {
    expect(localFileUrl('http://127.0.0.1:8787', '/Users/x/with space/p.html')).toBe(
      'http://127.0.0.1:8787/local-file/Users/x/with%20space/p.html',
    )
  })
  it('normalizes Windows backslashes and keeps a leading slash', () => {
    expect(localFileUrl('http://127.0.0.1:8787', 'C:\\proj\\page.html')).toBe(
      'http://127.0.0.1:8787/local-file/C%3A/proj/page.html',
    )
  })
  it('trims a trailing slash on the base', () => {
    expect(localFileUrl('http://127.0.0.1:8787/', '/a/b.html')).toBe(
      'http://127.0.0.1:8787/local-file/a/b.html',
    )
  })
})

describe('previewFsUrl', () => {
  const BASE = 'http://127.0.0.1:8787'

  it('builds a workspace-scoped preview-fs url for relative paths', () => {
    expect(previewFsUrl(BASE, 's1', 'out/index.html')).toBe(`${BASE}/preview-fs/s1/out/index.html`)
  })

  it('keeps the double slash that marks an absolute path', () => {
    expect(previewFsUrl(BASE, 's1', '/Users/me/a.png')).toBe(`${BASE}/preview-fs/s1//Users/me/a.png`)
    expect(previewFsUrl(BASE, 's1', '///Users/me/a.png')).toBe(`${BASE}/preview-fs/s1//Users/me/a.png`)
  })

  it('escapes each segment, so the server decodes exactly the name that was given', () => {
    expect(previewFsUrl(BASE, 's1', '/Users/me/My Pics/截图 1.png')).toBe(
      `${BASE}/preview-fs/s1//Users/me/My%20Pics/%E6%88%AA%E5%9B%BE%201.png`,
    )
  })

  it.each([
    ['a percent sign', '100%/a.png', '100%25/a.png'],
    ['a hash', 'a#b.png', 'a%23b.png'],
    ['a question mark', 'a?b.png', 'a%3Fb.png'],
  ])('escapes %s in a name instead of letting the URL read it as syntax', (_label, filePath, escaped) => {
    expect(previewFsUrl(BASE, 's1', filePath)).toBe(`${BASE}/preview-fs/s1/${escaped}`)
  })

  it.each([
    '%2e%2e/%2e%2e/api/status',
    '.%2e/api/status',
    '%2E%2E/api/status',
    'a/%2e%2e/%2e%2e/%2e%2e/api/status',
  ])('cannot be made to climb out of the session route by a name that spells a dot segment: %s', (filePath) => {
    // The URL parser collapses a percent-encoded `..` before the request is sent, so
    // an unescaped one would ask the server for `/api/status`, not for a file.
    const url = new URL(previewFsUrl(BASE, 's1', filePath))

    expect(url.pathname.startsWith('/preview-fs/s1/')).toBe(true)
  })

  it('reads the backslashes of a Windows path as separators, as the browser already did', () => {
    expect(previewFsUrl(BASE, 's1', 'C:\\proj\\out\\a.png')).toBe(`${BASE}/preview-fs/s1/C%3A/proj/out/a.png`)
  })
})
