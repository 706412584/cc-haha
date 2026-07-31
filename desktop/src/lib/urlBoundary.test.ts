import { describe, expect, it } from 'vitest'
import {
  isBareUrlOnly,
  matchBareUrl,
  splitTextByUrls,
  trimTrailingPunctuation,
} from './urlBoundary'

// Kept in sync with src/utils/urlBoundary.test.ts (the CLI copy). A divergence
// between the two tables means one platform's autolink drifted from the other.
const BOUNDARY_CASES: Array<{ input: string; expected: string | null; why: string }> = [
  { input: 'http://localhost:3000', expected: 'http://localhost:3000', why: 'bare host:port' },
  { input: 'http://localhost:3000。', expected: 'http://localhost:3000', why: 'full-width period' },
  { input: 'http://localhost:5173，然后刷新页面', expected: 'http://localhost:5173', why: 'full-width comma + rest of sentence' },
  { input: 'http://localhost:3000上运行', expected: 'http://localhost:3000', why: 'Han characters cannot continue an authority' },
  { input: 'http://localhost:3000）', expected: 'http://localhost:3000', why: 'full-width closing paren' },
  { input: 'http://localhost:3000」', expected: 'http://localhost:3000', why: 'full-width closing quote' },
  { input: 'http://localhost:3000、或者', expected: 'http://localhost:3000', why: 'ideographic comma' },
  { input: 'http://localhost:3000；完成', expected: 'http://localhost:3000', why: 'full-width semicolon' },
  { input: 'http://localhost:3000 查看', expected: 'http://localhost:3000', why: 'space ends the URL' },
  { input: 'https://github.com/NanmiCoder/cc-haha/issues/1145 里', expected: 'https://github.com/NanmiCoder/cc-haha/issues/1145', why: 'nested path' },
  { input: 'http://localhost:3000/api/users?id=1&name=zhang#top 试试', expected: 'http://localhost:3000/api/users?id=1&name=zhang#top', why: 'query + fragment' },
  { input: 'http://localhost:3000/文档.html 打开', expected: 'http://localhost:3000/文档.html', why: 'Han letters are legal inside a path' },
  { input: 'http://localhost:3000/预览。查看', expected: 'http://localhost:3000/预览', why: 'CJK punctuation still ends the path' },
  { input: 'https://en.wikipedia.org/wiki/Foo_(bar) 见', expected: 'https://en.wikipedia.org/wiki/Foo_(bar)', why: 'balanced closing paren stays' },
  { input: 'http://localhost:3000/path/。', expected: 'http://localhost:3000/path/', why: 'trailing slash kept, period dropped' },
  { input: 'http://localhost:3000).', expected: 'http://localhost:3000', why: 'unbalanced ASCII paren dropped' },
  { input: 'HTTP://LOCALHOST:3000', expected: 'HTTP://LOCALHOST:3000', why: 'scheme is case-insensitive' },
  { input: 'http://127.0.0.1:8080/x', expected: 'http://127.0.0.1:8080/x', why: 'IPv4 loopback' },
  { input: 'http://my-app.local:3000', expected: 'http://my-app.local:3000', why: 'hyphenated host' },
  { input: 'http://[::1]:8080/', expected: null, why: 'IPv6 literals stay plain text on purpose' },
  { input: 'ftp://localhost/x', expected: null, why: 'only http(s) autolinks' },
  { input: 'www.example.com', expected: null, why: 'schemeless is left to marked' },
  { input: '打开 http://localhost:3000', expected: null, why: 'matcher is anchored at index 0' },
]

describe('matchBareUrl', () => {
  for (const { input, expected, why } of BOUNDARY_CASES) {
    it(`${expected === null ? 'rejects' : 'ends at the right boundary for'} ${JSON.stringify(input)} (${why})`, () => {
      expect(matchBareUrl(input)).toBe(expected)
    })
  }

  it('never lets a percent-encoded CJK tail into the href', () => {
    // The exact regression from #1145: the swallowed sentence used to surface as
    // %EF%BC%8C… once the href went through URL encoding.
    const url = matchBareUrl('http://localhost:5173，然后刷新页面')
    expect(url).not.toBeNull()
    expect(encodeURI(url!)).not.toContain('%')
  })
})

describe('trimTrailingPunctuation', () => {
  it('strips ASCII and full-width sentence marks', () => {
    expect(trimTrailingPunctuation('docs/readme.md）')).toBe('docs/readme.md')
    expect(trimTrailingPunctuation('docs/readme.md).')).toBe('docs/readme.md')
    expect(trimTrailingPunctuation('docs/readme.md')).toBe('docs/readme.md')
  })

  it('leaves interior punctuation alone', () => {
    expect(trimTrailingPunctuation('a.b.c/d')).toBe('a.b.c/d')
  })
})

describe('splitTextByUrls', () => {
  it('returns a single text segment when there is no URL', () => {
    expect(splitTextByUrls('把样式改一下')).toEqual([{ type: 'text', value: '把样式改一下' }])
  })

  it('splits a URL out of surrounding Chinese prose', () => {
    expect(splitTextByUrls('把 http://localhost:3000 的样式改一下')).toEqual([
      { type: 'text', value: '把 ' },
      { type: 'url', value: 'http://localhost:3000' },
      { type: 'text', value: ' 的样式改一下' },
    ])
  })

  it('keeps CJK punctuation in the text segment instead of the URL', () => {
    expect(splitTextByUrls('打开 http://localhost:5173，然后刷新')).toEqual([
      { type: 'text', value: '打开 ' },
      { type: 'url', value: 'http://localhost:5173' },
      { type: 'text', value: '，然后刷新' },
    ])
  })

  it('handles several URLs on one line', () => {
    expect(splitTextByUrls('两个 http://localhost:3000 和 http://localhost:5173，都跑着')).toEqual([
      { type: 'text', value: '两个 ' },
      { type: 'url', value: 'http://localhost:3000' },
      { type: 'text', value: ' 和 ' },
      { type: 'url', value: 'http://localhost:5173' },
      { type: 'text', value: '，都跑着' },
    ])
  })

  it('preserves newlines so a pre-wrap container keeps its layout', () => {
    expect(splitTextByUrls('第一行\n\n打开 http://localhost:3000\n第三行')).toEqual([
      { type: 'text', value: '第一行\n\n打开 ' },
      { type: 'url', value: 'http://localhost:3000' },
      { type: 'text', value: '\n第三行' },
    ])
  })

  it('does not re-split a scheme that sits inside an already consumed URL', () => {
    expect(splitTextByUrls('http://a.com/?next=http://b.com')).toEqual([
      { type: 'url', value: 'http://a.com/?next=http://b.com' },
    ])
  })

  it('leaves an unmatchable scheme in the text', () => {
    expect(splitTextByUrls('地址 http://[::1]:8080 上')).toEqual([
      { type: 'text', value: '地址 http://[::1]:8080 上' },
    ])
  })

  it('emits nothing for an empty string', () => {
    expect(splitTextByUrls('')).toEqual([])
  })
})

describe('isBareUrlOnly', () => {
  it('accepts inline code that is exactly one URL', () => {
    expect(isBareUrlOnly('http://localhost:3000')).toBe(true)
    expect(isBareUrlOnly(' http://localhost:3000/ ')).toBe(true)
  })

  it('rejects inline code that is a command or a fragment', () => {
    expect(isBareUrlOnly('curl http://localhost:3000')).toBe(false)
    expect(isBareUrlOnly('npm install')).toBe(false)
    expect(isBareUrlOnly('http://localhost:3000 然后刷新')).toBe(false)
    expect(isBareUrlOnly('')).toBe(false)
  })
})
