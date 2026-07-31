import { describe, expect, test } from 'bun:test'
import {
  isBareUrlOnly,
  matchBareUrl,
  splitTextByUrls,
  trimTrailingPunctuation,
} from './urlBoundary.js'

// Kept in sync with desktop/src/lib/urlBoundary.test.ts. A divergence between the
// two tables means one platform's autolink drifted from the other.
const BOUNDARY_CASES: Array<{
  input: string
  expected: string | null
  why: string
}> = [
  {
    input: 'http://localhost:3000',
    expected: 'http://localhost:3000',
    why: 'bare host:port',
  },
  {
    input: 'http://localhost:3000。',
    expected: 'http://localhost:3000',
    why: 'full-width period',
  },
  {
    input: 'http://localhost:5173，然后刷新页面',
    expected: 'http://localhost:5173',
    why: 'full-width comma + rest of sentence',
  },
  {
    input: 'http://localhost:3000上运行',
    expected: 'http://localhost:3000',
    why: 'Han characters cannot continue an authority',
  },
  {
    input: 'http://localhost:3000）',
    expected: 'http://localhost:3000',
    why: 'full-width closing paren',
  },
  {
    input: 'http://localhost:3000」',
    expected: 'http://localhost:3000',
    why: 'full-width closing quote',
  },
  {
    input: 'http://localhost:3000、或者',
    expected: 'http://localhost:3000',
    why: 'ideographic comma',
  },
  {
    input: 'http://localhost:3000；完成',
    expected: 'http://localhost:3000',
    why: 'full-width semicolon',
  },
  {
    input: 'http://localhost:3000 查看',
    expected: 'http://localhost:3000',
    why: 'space ends the URL',
  },
  {
    input: 'https://github.com/NanmiCoder/cc-haha/issues/1145 里',
    expected: 'https://github.com/NanmiCoder/cc-haha/issues/1145',
    why: 'nested path',
  },
  {
    input: 'http://localhost:3000/api/users?id=1&name=zhang#top 试试',
    expected: 'http://localhost:3000/api/users?id=1&name=zhang#top',
    why: 'query + fragment',
  },
  {
    input: 'http://localhost:3000/文档.html 打开',
    expected: 'http://localhost:3000/文档.html',
    why: 'Han letters are legal inside a path',
  },
  {
    input: 'http://localhost:3000/预览。查看',
    expected: 'http://localhost:3000/预览',
    why: 'CJK punctuation still ends the path',
  },
  {
    input: 'https://en.wikipedia.org/wiki/Foo_(bar) 见',
    expected: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    why: 'balanced closing paren stays',
  },
  {
    input: 'http://localhost:3000/path/。',
    expected: 'http://localhost:3000/path/',
    why: 'trailing slash kept, period dropped',
  },
  {
    input: 'http://localhost:3000).',
    expected: 'http://localhost:3000',
    why: 'unbalanced ASCII paren dropped',
  },
  {
    input: 'HTTP://LOCALHOST:3000',
    expected: 'HTTP://LOCALHOST:3000',
    why: 'scheme is case-insensitive',
  },
  {
    input: 'http://127.0.0.1:8080/x',
    expected: 'http://127.0.0.1:8080/x',
    why: 'IPv4 loopback',
  },
  {
    input: 'http://my-app.local:3000',
    expected: 'http://my-app.local:3000',
    why: 'hyphenated host',
  },
  {
    input: 'http://[::1]:8080/',
    expected: null,
    why: 'IPv6 literals stay plain text on purpose',
  },
  { input: 'ftp://localhost/x', expected: null, why: 'only http(s) autolinks' },
  {
    input: 'www.example.com',
    expected: null,
    why: 'schemeless is left to marked',
  },
  {
    input: '打开 http://localhost:3000',
    expected: null,
    why: 'matcher is anchored at index 0',
  },
]

describe('matchBareUrl', () => {
  for (const { input, expected, why } of BOUNDARY_CASES) {
    test(`${expected === null ? 'rejects' : 'ends at the right boundary for'} ${JSON.stringify(input)} (${why})`, () => {
      expect(matchBareUrl(input)).toBe(expected)
    })
  }
})

describe('trimTrailingPunctuation', () => {
  test('strips ASCII and full-width sentence marks', () => {
    expect(trimTrailingPunctuation('docs/readme.md）')).toBe('docs/readme.md')
    expect(trimTrailingPunctuation('docs/readme.md).')).toBe('docs/readme.md')
    expect(trimTrailingPunctuation('docs/readme.md')).toBe('docs/readme.md')
  })

  test('leaves interior punctuation alone', () => {
    expect(trimTrailingPunctuation('a.b.c/d')).toBe('a.b.c/d')
  })
})

describe('splitTextByUrls', () => {
  test('returns a single text segment when there is no URL', () => {
    expect(splitTextByUrls('把样式改一下')).toEqual([
      { type: 'text', value: '把样式改一下' },
    ])
  })

  test('splits a URL out of surrounding Chinese prose', () => {
    expect(splitTextByUrls('打开 http://localhost:5173，然后刷新')).toEqual([
      { type: 'text', value: '打开 ' },
      { type: 'url', value: 'http://localhost:5173' },
      { type: 'text', value: '，然后刷新' },
    ])
  })

  test('handles several URLs on one line', () => {
    expect(
      splitTextByUrls('两个 http://localhost:3000 和 http://localhost:5173，都跑着'),
    ).toEqual([
      { type: 'text', value: '两个 ' },
      { type: 'url', value: 'http://localhost:3000' },
      { type: 'text', value: ' 和 ' },
      { type: 'url', value: 'http://localhost:5173' },
      { type: 'text', value: '，都跑着' },
    ])
  })

  test('preserves newlines', () => {
    expect(splitTextByUrls('第一行\n打开 http://localhost:3000\n第三行')).toEqual([
      { type: 'text', value: '第一行\n打开 ' },
      { type: 'url', value: 'http://localhost:3000' },
      { type: 'text', value: '\n第三行' },
    ])
  })

  test('does not re-split a scheme inside an already consumed URL', () => {
    expect(splitTextByUrls('http://a.com/?next=http://b.com')).toEqual([
      { type: 'url', value: 'http://a.com/?next=http://b.com' },
    ])
  })

  test('leaves an unmatchable scheme in the text', () => {
    expect(splitTextByUrls('地址 http://[::1]:8080 上')).toEqual([
      { type: 'text', value: '地址 http://[::1]:8080 上' },
    ])
  })

  test('emits nothing for an empty string', () => {
    expect(splitTextByUrls('')).toEqual([])
  })
})

describe('isBareUrlOnly', () => {
  test('accepts inline code that is exactly one URL', () => {
    expect(isBareUrlOnly('http://localhost:3000')).toBe(true)
    expect(isBareUrlOnly(' http://localhost:3000/ ')).toBe(true)
  })

  test('rejects inline code that is a command or a fragment', () => {
    expect(isBareUrlOnly('curl http://localhost:3000')).toBe(false)
    expect(isBareUrlOnly('npm install')).toBe(false)
    expect(isBareUrlOnly('http://localhost:3000 然后刷新')).toBe(false)
    expect(isBareUrlOnly('')).toBe(false)
  })
})
