import { strToU8, zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LINKS,
  altChunkDocx,
  injectionDocx,
  packDocx,
  tallDocx,
  thesisDocx,
} from '@/test/fixtures/docx'
import { DEFAULT_OFFICE_ZIP_LIMITS } from '@/lib/workspace/officeZipGuard'
import { DOCX_RENDER_OPTIONS, DocxError, createDocxEngine, defaultDocxEngine } from './docxEngine'

/** The real docx-preview, drawing into a plain container: what the engine does, without a frame around it. */
const realEngine = createDocxEngine({ loadDocx: () => import('docx-preview') })

let body: HTMLElement
let styles: HTMLElement

beforeEach(() => {
  document.body.replaceChildren()
  body = document.body.appendChild(document.createElement('div'))
  styles = document.body.appendChild(document.createElement('div'))
})

async function draw(bytes: Uint8Array) {
  await realEngine.render(bytes, { body, styles })
}

describe('docxEngine with the real docx-preview', () => {
  it('draws a thesis-shaped document: text, Chinese, a table, a picture', async () => {
    await draw(thesisDocx())

    const text = body.textContent ?? ''
    expect(text).toContain('第一章 绪论 Introduction')
    expect(text).toContain('italic red 中文段落，用于检查换行与字体。')
    expect(text).toContain('R2C3 单元格')
    expect(body.querySelectorAll('table').length).toBe(1)
    expect(body.querySelectorAll('td').length).toBe(6)
  })

  it('breaks the document into pages', async () => {
    await draw(thesisDocx())

    expect(body.querySelectorAll('.docx-wrapper > section.docx').length).toBe(3)
  })

  it('embeds pictures as data: URLs, the one kind of source the frame’s policy allows', async () => {
    await draw(thesisDocx())

    const sources = [...body.querySelectorAll('img')].map((image) => image.getAttribute('src') ?? '')
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatch(/^data:image\/png;base64,/)
  })

  it('does not draw the HTML a document can carry: that would be a frame without a sandbox', async () => {
    await draw(altChunkDocx('http://probe.invalid'))

    expect(body.querySelector('iframe')).toBeNull()
    expect(body.textContent).not.toContain('ALTCHUNK-HTML')
    expect(body.innerHTML).not.toContain('probe.invalid')
    // The document around it still reads.
    expect(body.textContent).toContain('Before altChunk')
    expect(body.textContent).toContain('After altChunk')
  })

  it('draws markup in a paragraph’s text as text, not as elements', async () => {
    await draw(injectionDocx('http://probe.invalid'))

    expect(body.querySelector('script')).toBeNull()
    expect(body.querySelector('img[src="x"]')).toBeNull()
    expect(body.querySelector('[onerror]')).toBeNull()
    expect(body.textContent).toContain('<img src=x onerror="window.parent.__textXss=1">')
  })

  it('leaves the links exactly as the document wrote them: making them safe is the frame’s job', async () => {
    await draw(thesisDocx())

    const hrefs = [...body.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))
    expect(hrefs).toEqual(expect.arrayContaining([LINKS.https, LINKS.javascript, LINKS.file, LINKS.mailto, '#bm1']))
  })

  it('draws into the container it is given and nowhere else', async () => {
    const elsewhere = document.body.appendChild(document.createElement('div'))

    await draw(tallDocx(2))

    expect(body.textContent).toContain('Page 2 line 20')
    expect(elsewhere.children).toHaveLength(0)
  })

  it('writes its stylesheet to the styles container, not the pages', async () => {
    await draw(thesisDocx())

    expect(styles.querySelectorAll('style').length).toBeGreaterThan(0)
    expect(body.querySelectorAll('style')).toHaveLength(0)
  })
})

describe('docxEngine failures', () => {
  it.each([
    ['text', strToU8('this is not a document')],
    ['nothing', new Uint8Array(0)],
  ])('answers %s with `invalid`', async (_label, bytes) => {
    const failure = await realEngine.render(bytes, { body, styles }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DocxError)
    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('answers a document cut off mid-write (an agent still at it) with `invalid`', async () => {
    const whole = thesisDocx()

    const failure = await realEngine.render(whole.slice(0, Math.floor(whole.length / 2)), { body, styles }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('answers a zip that is not a Word document with `invalid`', async () => {
    const notAWordDocument = zipSync({ 'hello.txt': strToU8('hello') })

    const failure = await realEngine.render(notAWordDocument, { body, styles }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('answers a zip whose main part is broken with `invalid`', async () => {
    const broken = packDocx({ body: '<w:p><w:r><w:t>unclosed' })

    const failure = await realEngine.render(broken, { body, styles }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'invalid' })
  })

  it('answers an archive that promises to inflate past all reason with `tooComplex`, before unpacking any of it', async () => {
    const loadDocx = vi.fn(async () => ({ renderAsync: vi.fn() }) as never)
    // Limits small enough to break with a fixture that fits in a test; the ones the app uses are the guard's own.
    const zipLimits = { ...DEFAULT_OFFICE_ZIP_LIMITS, maxEntryBytes: 1024 * 1024 }
    const engine = createDocxEngine({ loadDocx, zipLimits })
    const bomb = zipSync({ 'word/media/huge.bmp': new Uint8Array(4 * 1024 * 1024) })
    expect(bomb.length).toBeLessThan(16 * 1024)

    const failure = await engine.render(bomb, { body, styles }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'tooComplex' })
    expect(loadDocx).not.toHaveBeenCalled()
  })

  it('reports docx-preview failing to load as `unavailable`, not as a broken document', async () => {
    const engine = createDocxEngine({ loadDocx: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) })

    const failure = await engine.render(thesisDocx(), { body, styles }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'unavailable' })
  })

  it('keeps the original error for whoever wants to log it', async () => {
    const cause = new Error('boom')
    const engine = createDocxEngine({ loadDocx: () => Promise.reject(cause) })

    const failure = await engine.render(thesisDocx(), { body, styles }).catch((error: unknown) => error)

    expect((failure as DocxError).reason).toBe(cause)
  })
})

describe('the options docx-preview is given', () => {
  it('leaves off the two things that would put an unsandboxed or unreachable thing in the frame', () => {
    expect(DOCX_RENDER_OPTIONS.renderAltChunks).toBe(false)
    expect(DOCX_RENDER_OPTIONS.useBase64URL).toBe(true)
  })

  it('passes them on to the library', async () => {
    const renderAsync = vi.fn().mockResolvedValue(undefined)
    const engine = createDocxEngine({ loadDocx: async () => ({ renderAsync }) as never })

    await engine.render(thesisDocx(), { body, styles })

    expect(renderAsync).toHaveBeenCalledWith(expect.any(Uint8Array), body, styles, DOCX_RENDER_OPTIONS)
  })
})

describe('the default engine', () => {
  it('is built on docx-preview, loaded when a document is first drawn', async () => {
    await defaultDocxEngine.render(tallDocx(1), { body, styles })

    expect(body.textContent).toContain('Page 1 line 1')
  })
})
