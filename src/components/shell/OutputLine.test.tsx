import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { linkifyUrlsInText } from './OutputLine.js'

const originalTermProgram = process.env['TERM_PROGRAM']

beforeAll(() => {
  // ghostty is on the OSC 8 allow-list regardless of TTY, so the escape
  // sequences are real under `bun test`.
  process.env['TERM_PROGRAM'] = 'ghostty'
})

afterAll(() => {
  if (originalTermProgram === undefined) {
    delete process.env['TERM_PROGRAM']
  } else {
    process.env['TERM_PROGRAM'] = originalTermProgram
  }
})

/** The URLs each OSC 8 sequence points at. */
function hyperlinkTargets(rendered: string): string[] {
  return [...rendered.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)]
    .map(match => match[1])
    .filter((target): target is string => Boolean(target))
}

// The previous regex (`https?:\/\/[^\s"'<>\\]+`) had the same flaw as marked's
// GFM autolink: full-width punctuation and Han characters are none of the excluded
// characters, so trailing Chinese ended up inside the link target.
describe('linkifyUrlsInText', () => {
  test('stops the target at full-width punctuation', () => {
    expect(hyperlinkTargets(linkifyUrlsInText('代理地址: http://127.0.0.1:15721。'))).toEqual([
      'http://127.0.0.1:15721',
    ])
  })

  test('stops the target at Han characters', () => {
    expect(hyperlinkTargets(linkifyUrlsInText('服务在http://localhost:3000上运行'))).toEqual([
      'http://localhost:3000',
    ])
  })

  test('keeps the surrounding text intact', () => {
    const rendered = linkifyUrlsInText('打开 http://localhost:5173，然后刷新')
    expect(rendered).toContain('打开 ')
    expect(rendered).toContain('，然后刷新')
  })

  test('links every URL and leaves plain text alone', () => {
    expect(hyperlinkTargets(linkifyUrlsInText('a http://x.com/1 b https://y.com/2 c'))).toEqual([
      'http://x.com/1',
      'https://y.com/2',
    ])
    expect(linkifyUrlsInText('no urls here')).toBe('no urls here')
  })
})
