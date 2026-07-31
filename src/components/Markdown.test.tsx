import { describe, expect, test } from 'bun:test'
import { hasMarkdownSyntax } from './Markdown.js'

// #1145. hasMarkdownSyntax gates the fast path that skips marked.lexer entirely,
// and the lexer is what turns a bare URL into an OSC 8 hyperlink. A plain Chinese
// sentence carries none of the markdown markers, so it used to take the fast path
// and render its URL as dead text — while the same sentence in English usually
// contained a `-` or a backtick and linked fine.
describe('hasMarkdownSyntax', () => {
  test.each([
    '请访问 http://localhost:3000 查看效果',
    '开发服务器已启动：http://localhost:3000',
    '前端服务在 http://localhost:5173 上跑起来了',
    '已完成。打开 https://example.com 就能看到页面了',
  ])('routes %j to the lexer so its URL can be linked', content => {
    expect(hasMarkdownSyntax(content)).toBe(true)
  })

  test.each([
    '好的，我已经改完了',
    '这段逻辑没有问题',
  ])('keeps the fast path for %j', content => {
    expect(hasMarkdownSyntax(content)).toBe(false)
  })

  test.each([
    '# 标题',
    '- 列表项',
    '`code`',
    '**bold**',
    '1. 有序列表',
    '两段\n\n之间',
  ])('still detects real markdown in %j', content => {
    expect(hasMarkdownSyntax(content)).toBe(true)
  })

  // The markdown markers are still only sampled from the first 500 chars, but a
  // URL is scanned for across the whole string: an assistant summary very often
  // puts its dev-server URL in the closing line, well past the sample window.
  test('finds a URL past the 500-char sample window', () => {
    expect(hasMarkdownSyntax(`${'好'.repeat(600)}打开 http://localhost:3000`)).toBe(true)
  })

  test('still samples only the first 500 chars for markdown markers', () => {
    expect(hasMarkdownSyntax(`${'好'.repeat(600)}**bold**`)).toBe(false)
  })
})
