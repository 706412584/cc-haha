import { describe, expect, it } from 'vitest'

import {
  createWorkspaceMarkdownImageResolver,
  isSafeMarkdownImageSource,
} from './markdownImages'

const CONTEXT = {
  baseUrl: 'http://127.0.0.1:3456',
  sessionId: 'session-1',
  filePath: 'docs/guide.md',
  workDir: '/repo',
}

describe('isSafeMarkdownImageSource', () => {
  it('accepts blob and base64 data image sources', () => {
    expect(isSafeMarkdownImageSource('blob:https://desktop.invalid/1234')).toBe(true)
    expect(isSafeMarkdownImageSource('data:image/png;base64,AAAA')).toBe(true)
    expect(isSafeMarkdownImageSource('data:image/svg+xml;base64,AAAA')).toBe(false)
  })

  it('rejects network and relative sources', () => {
    expect(isSafeMarkdownImageSource('https://example.com/a.png')).toBe(false)
    expect(isSafeMarkdownImageSource('assets/a.png')).toBe(false)
    expect(isSafeMarkdownImageSource(null)).toBe(false)
  })
})

describe('createWorkspaceMarkdownImageResolver', () => {
  const resolve = createWorkspaceMarkdownImageResolver(CONTEXT)

  it('resolves same-directory relative paths against the markdown file directory', () => {
    expect(resolve('assets/logo.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/assets/logo.png',
    )
  })

  it('resolves ./ prefixes and parent traversal inside the workspace', () => {
    expect(resolve('./assets/logo.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/assets/logo.png',
    )
    expect(resolve('../shared/banner.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/shared/banner.png',
    )
  })

  it('resolves images of a root-level markdown file', () => {
    const rootResolve = createWorkspaceMarkdownImageResolver({ ...CONTEXT, filePath: 'README.md' })
    expect(rootResolve('docs/assets/logo.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/assets/logo.png',
    )
  })

  it('keeps remote http(s) image URLs untouched', () => {
    expect(resolve('https://img.shields.io/badge/stars-1k.svg')).toBe(
      'https://img.shields.io/badge/stars-1k.svg',
    )
    expect(resolve('http://127.0.0.1:8787/frame.png')).toBe('http://127.0.0.1:8787/frame.png')
  })

  it('keeps safe inline image sources untouched', () => {
    expect(resolve('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(resolve('blob:https://desktop.invalid/1234')).toBe('blob:https://desktop.invalid/1234')
  })

  it('routes absolute local paths through /local-file', () => {
    expect(resolve('/Users/me/pic.png')).toBe(
      'http://127.0.0.1:3456/local-file/Users/me/pic.png',
    )
  })

  it('routes workspace escapes through /local-file when the workDir is known', () => {
    expect(resolve('../../outside.png')).toBe(
      'http://127.0.0.1:3456/local-file/outside.png',
    )
  })

  it('rejects workspace escapes when the workDir is unknown', () => {
    const noWorkDir = createWorkspaceMarkdownImageResolver({ ...CONTEXT, workDir: null })
    expect(noWorkDir('../../outside.png')).toBeNull()
  })

  it('passes spaces and unicode through for the browser to encode', () => {
    // previewFsUrl keeps the workspace path raw; the browser percent-encodes it
    // on request and the server decodes each segment again.
    expect(resolve('截图/界面 1.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/截图/界面 1.png',
    )
  })

  it('drops query strings and fragments from local paths', () => {
    expect(resolve('assets/logo.png?v=2#frag')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/assets/logo.png',
    )
  })

  it('rejects non-loadable sources', () => {
    expect(resolve('')).toBeNull()
    expect(resolve('#anchor')).toBeNull()
    expect(resolve('javascript:alert(1)')).toBeNull()
    expect(resolve('file:///etc/passwd')).toBeNull()
    expect(resolve('data:text/html;base64,AAAA')).toBeNull()
  })
})
