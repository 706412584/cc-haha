import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { OSC8_END, OSC8_START } from './hyperlink.js'
import { applyMarkdown } from './markdown.js'

// #1145. Bare URLs in Chinese prose rendered as dead text: a plain Chinese
// sentence carries none of the markers in Markdown.tsx's fast-path regex, so it
// never reached marked.lexer, and the sentences that did reach it had the trailing
// Chinese swallowed into the link target by GFM's ASCII-only autolink boundary.

const originalTermProgram = process.env['TERM_PROGRAM']

beforeAll(() => {
  // supportsHyperlinks() treats ghostty as OSC 8 capable regardless of TTY, which
  // is what lets the assertions below see real escape sequences under `bun test`.
  process.env['TERM_PROGRAM'] = 'ghostty'
})

afterAll(() => {
  if (originalTermProgram === undefined) {
    delete process.env['TERM_PROGRAM']
  } else {
    process.env['TERM_PROGRAM'] = originalTermProgram
  }
})

/** The URLs each OSC 8 sequence in `rendered` points at. */
function hyperlinkTargets(rendered: string): string[] {
  const targets: string[] = []
  const pattern = new RegExp(
    `${escapeRegExp(OSC8_START)}([^${escapeRegExp(OSC8_END)}]*)${escapeRegExp(OSC8_END)}`,
    'g',
  )
  for (const match of rendered.matchAll(pattern)) {
    const target = match[1]
    if (target) targets.push(target)
  }
  return targets
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('applyMarkdown bare-URL hyperlinks', () => {
  test('links a bare URL inside a plain Chinese sentence', () => {
    const rendered = applyMarkdown('请访问 http://localhost:3000 查看效果', 'dark')
    expect(hyperlinkTargets(rendered)).toEqual(['http://localhost:3000'])
  })

  test.each([
    ['开发服务器已启动：http://localhost:3000。', 'http://localhost:3000'],
    ['打开 http://localhost:5173，然后刷新页面', 'http://localhost:5173'],
    ['服务在http://localhost:3000上运行', 'http://localhost:3000'],
    ['打开（http://localhost:3000）看看', 'http://localhost:3000'],
  ])('keeps Chinese text out of the link target in %j', (content, target) => {
    expect(hyperlinkTargets(applyMarkdown(content, 'dark'))).toEqual([target])
  })

  test('leaves the trailing Chinese visible as text', () => {
    const rendered = applyMarkdown('打开 http://localhost:5173，然后刷新页面', 'dark')
    expect(rendered).toContain('，然后刷新页面')
  })

  test('links every URL on a line', () => {
    const rendered = applyMarkdown(
      '两个 http://localhost:3000 和 http://localhost:5173，都跑着',
      'dark',
    )
    expect(hyperlinkTargets(rendered)).toEqual([
      'http://localhost:3000',
      'http://localhost:5173',
    ])
  })

  test('still autolinks schemeless www hosts through the built-in tokenizer', () => {
    const rendered = applyMarkdown('裸域名 www.example.com 呢', 'dark')
    expect(hyperlinkTargets(rendered)).toEqual(['http://www.example.com'])
  })

  test('keeps a markdown link label from nesting a second target', () => {
    const rendered = applyMarkdown(
      '见 [http://localhost:3000](http://localhost:3000/real)',
      'dark',
    )
    expect(hyperlinkTargets(rendered)).toEqual(['http://localhost:3000/real'])
  })

  test('links inline code that is nothing but a URL', () => {
    const rendered = applyMarkdown('访问 `http://localhost:3000` 就能看到', 'dark')
    expect(hyperlinkTargets(rendered)).toEqual(['http://localhost:3000'])
  })

  test('leaves inline code that is a command unlinked', () => {
    const rendered = applyMarkdown('跑 `curl http://localhost:3000` 试试', 'dark')
    expect(hyperlinkTargets(rendered)).toEqual([])
    expect(rendered).toContain('curl http://localhost:3000')
  })

  test('leaves a fenced code block unlinked', () => {
    const rendered = applyMarkdown(
      '```log\n[INFO] 代理地址: http://127.0.0.1:15721\n```',
      'dark',
    )
    expect(hyperlinkTargets(rendered)).toEqual([])
    expect(rendered).toContain('http://127.0.0.1:15721')
  })

  test('still linkifies owner/repo#123 references', () => {
    const rendered = applyMarkdown('见 NanmiCoder/cc-haha#1145 的讨论', 'dark')
    expect(hyperlinkTargets(rendered)).toEqual([
      'https://github.com/NanmiCoder/cc-haha/issues/1145',
    ])
  })
})
