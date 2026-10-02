import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FRAME_SANDBOX,
  INNER_CSP,
  applyZoom,
  attachFrameListeners,
  classifyHref,
  contentHeight,
  createDocxFrame,
  currentColorScheme,
  documentPaperColor,
  frameSrcdoc,
  naturalPageWidth,
  neutraliseLinks,
  presentationCss,
  type FrameHandlers,
} from './docxFrame'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  document.documentElement.style.removeProperty('color-scheme')
  document.documentElement.style.removeProperty('--color-document-paper')
})

describe('the sandbox', () => {
  it('is exactly allow-same-origin: the page can draw into the frame, and nothing in the frame can run', () => {
    expect(FRAME_SANDBOX).toBe('allow-same-origin')
  })

  it.each(['allow-scripts', 'allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-modals', 'allow-downloads'])(
    'never grants %s',
    (permission) => {
      expect(FRAME_SANDBOX.split(/\s+/)).not.toContain(permission)
    },
  )

  it('is what a frame is created with', () => {
    const { frame } = createDocxFrame(document.body, 'light')

    expect(frame.getAttribute('sandbox')).toBe(FRAME_SANDBOX)
  })
})

describe('the policy inside the frame', () => {
  it('allows nothing by default, and only data: pictures and fonts and inline style on top of that', () => {
    const directives = Object.fromEntries(INNER_CSP.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/)
      return [name, values]
    }))

    expect(directives['default-src']).toEqual(["'none'"])
    expect(directives['img-src']).toEqual(['data:'])
    expect(directives['font-src']).toEqual(['data:'])
    expect(directives['style-src']).toEqual(["'unsafe-inline'"])
    // Nothing that would let a script or a request out.
    expect(Object.keys(directives).sort()).toEqual(['default-src', 'font-src', 'img-src', 'style-src'])
  })

  it('names no host, and no scheme that fetches anything', () => {
    expect(INNER_CSP).not.toMatch(/https?:|\*|blob:|filesystem:|'self'|script-src|connect-src|frame-src/)
  })
})

describe('frameSrcdoc', () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html')

  it('puts the policy first in the document, so that it governs everything after it', () => {
    const head = parse(frameSrcdoc('dark')).head

    const first = head.firstElementChild
    expect(first?.tagName).toBe('META')
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(first?.getAttribute('content')).toBe(INNER_CSP)
  })

  it('carries the page’s colour scheme, so that the frame stays transparent over the page’s surround', () => {
    expect(parse(frameSrcdoc('dark')).querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('dark')
    expect(parse(frameSrcdoc('light')).querySelector('meta[name="color-scheme"]')?.getAttribute('content')).toBe('light')
  })

  it('says nothing about a scheme it does not know', () => {
    expect(parse(frameSrcdoc(null)).querySelector('meta[name="color-scheme"]')).toBeNull()
  })

  it('starts empty and transparent', () => {
    const doc = parse(frameSrcdoc('light'))

    expect(doc.body.children).toHaveLength(0)
    expect(doc.head.querySelector('style')?.textContent).toContain('background:transparent')
    expect(doc.querySelector('script')).toBeNull()
  })

  it('does not mention a script or a remote address anywhere', () => {
    expect(frameSrcdoc('light')).not.toMatch(/<script|https?:\/\//i)
  })
})

describe('currentColorScheme', () => {
  it.each(['light', 'dark'] as const)('reads %s from the page', (scheme) => {
    document.documentElement.style.colorScheme = scheme

    expect(currentColorScheme()).toBe(scheme)
  })

  it('does not guess when the page says nothing', () => {
    document.documentElement.style.removeProperty('color-scheme')

    expect(currentColorScheme()).toBeNull()
  })
})

describe('createDocxFrame', () => {
  it('starts the frame from the sandboxed document, and adds it to the host', () => {
    const host = document.body.appendChild(document.createElement('div'))

    const { frame } = createDocxFrame(host, 'dark')

    expect(frame.parentElement).toBe(host)
    expect(frame.srcdoc).toBe(frameSrcdoc('dark'))
  })

  it('resolves with the frame’s document once it has loaded', async () => {
    const { frame, ready } = createDocxFrame(document.body, 'light')

    const doc = await ready

    expect(doc).toBe(frame.contentDocument)
  })

  it('gives up on a frame that never loads', async () => {
    vi.useFakeTimers()
    const host = document.body.appendChild(document.createElement('div'))
    // A frame that is not in a document never fires `load`.
    vi.spyOn(host, 'append').mockImplementation(() => undefined)
    const { ready } = createDocxFrame(host, 'light')
    const outcome = ready.then(() => 'loaded', (error: Error) => error.message)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(await outcome).toBe('The document frame did not load')
  })

  it('is not focusable by tabbing, and has no height until it has something to show', () => {
    const { frame } = createDocxFrame(document.body, 'light')

    expect(frame.getAttribute('tabindex')).toBe('-1')
    expect(frame.style.height).toBe('0px')
  })
})

describe('classifyHref', () => {
  it.each([
    ['https://example.com/docs', { kind: 'external', url: 'https://example.com/docs' }],
    ['http://example.com/', { kind: 'external', url: 'http://example.com/' }],
    ['mailto:someone@example.com', { kind: 'external', url: 'mailto:someone@example.com' }],
    ['#bm1', { kind: 'anchor', id: 'bm1' }],
    ['#%E7%AB%A0%E8%8A%82', { kind: 'anchor', id: '章节' }],
  ])('lets %s through as %j', (href, expected) => {
    expect(classifyHref(href)).toEqual(expected)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'file:///etc/hosts',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/abc',
    'vbscript:msgbox(1)',
    'ftp://example.com/x',
    'tel:+123',
    '/api/sessions',
    '../secret',
    'relative/path.html',
    '',
    '#%E0%A4%A',
  ])('leaves %j nowhere to go', (href) => {
    expect(classifyHref(href)).toEqual({ kind: 'inert' })
  })
})

describe('neutraliseLinks', () => {
  function links(html: string) {
    const root = document.createElement('div')
    root.innerHTML = html
    neutraliseLinks(root)
    return [...root.querySelectorAll('a')]
  }

  it('takes the href off a link that leads nowhere, so that no gesture can follow it', () => {
    const [js, file, data] = links('<a href="javascript:alert(1)">a</a><a href="file:///etc/hosts">b</a><a href="data:text/html,x">c</a>')

    expect(js!.hasAttribute('href')).toBe(false)
    expect(file!.hasAttribute('href')).toBe(false)
    expect(data!.hasAttribute('href')).toBe(false)
  })

  it('keeps the href of a link that may go somewhere', () => {
    const [web, mail, bookmark] = links('<a href="https://example.com">a</a><a href="mailto:x@y.z">b</a><a href="#bm1">c</a>')

    expect(web!.getAttribute('href')).toBe('https://example.com')
    expect(mail!.getAttribute('href')).toBe('mailto:x@y.z')
    expect(bookmark!.getAttribute('href')).toBe('#bm1')
  })

  it('stops any link opening a window of its own, or telling the destination where it came from', () => {
    const anchors = links('<a href="https://example.com" target="_blank">a</a><a href="javascript:1" target="_top">b</a>')

    for (const anchor of anchors) {
      expect(anchor.hasAttribute('target')).toBe(false)
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('leaves a bookmark that is not a link alone', () => {
    const root = document.createElement('div')
    root.innerHTML = '<a name="bm1">target</a>'

    neutraliseLinks(root)

    expect(root.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(root.querySelector('a')?.getAttribute('name')).toBe('bm1')
  })
})

describe('attachFrameListeners', () => {
  let frameDocument: Document
  let handlers: { [K in keyof FrameHandlers]: ReturnType<typeof vi.fn> }
  let detach: () => void

  beforeEach(() => {
    frameDocument = document.implementation.createHTMLDocument('frame')
    handlers = { onExternalLink: vi.fn(), onWheelZoom: vi.fn(), onZoomKey: vi.fn() }
    detach = attachFrameListeners(frameDocument, handlers as unknown as FrameHandlers)
  })

  function click(target: Element) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  function anchorWith(href: string | null, content = 'link') {
    const anchor = frameDocument.createElement('a')
    if (href !== null) anchor.setAttribute('href', href)
    anchor.innerHTML = `<span>${content}</span>`
    frameDocument.body.append(anchor)
    return anchor
  }

  it('hands a web link to the application instead of letting the frame navigate', () => {
    const event = click(anchorWith('https://example.com/docs'))

    expect(event.defaultPrevented).toBe(true)
    expect(handlers.onExternalLink).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('finds the link when the click lands on something inside it', () => {
    const anchor = anchorWith('https://example.com/inside')

    click(anchor.querySelector('span')!)

    expect(handlers.onExternalLink).toHaveBeenCalledWith('https://example.com/inside')
  })

  it.each(['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,x', '/relative', null])(
    'does nothing at all with %j, beyond keeping the frame where it is',
    (href) => {
      const event = click(anchorWith(href))

      expect(event.defaultPrevented).toBe(true)
      expect(handlers.onExternalLink).not.toHaveBeenCalled()
    },
  )

  it('scrolls to a bookmark inside the document', () => {
    const target = frameDocument.createElement('p')
    target.id = 'bm1'
    target.scrollIntoView = vi.fn()
    frameDocument.body.append(target)

    click(anchorWith('#bm1'))

    expect(target.scrollIntoView).toHaveBeenCalled()
    expect(handlers.onExternalLink).not.toHaveBeenCalled()
  })

  it('finds a bookmark by name too, which is how Word writes them', () => {
    const target = frameDocument.createElement('a')
    target.setAttribute('name', 'bm2')
    target.scrollIntoView = vi.fn()
    frameDocument.body.append(target)

    click(anchorWith('#bm2'))

    expect(target.scrollIntoView).toHaveBeenCalled()
  })

  it('does not mind a bookmark that is not there', () => {
    expect(() => click(anchorWith('#nowhere'))).not.toThrow()
  })

  it('leaves a click on plain text alone', () => {
    const paragraph = frameDocument.createElement('p')
    frameDocument.body.append(paragraph)

    const event = click(paragraph)

    expect(event.defaultPrevented).toBe(false)
    expect(handlers.onExternalLink).not.toHaveBeenCalled()
  })

  describe('the wheel', () => {
    const wheel = (init: WheelEventInit) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
      frameDocument.body.dispatchEvent(event)
      return event
    }

    it.each([['Ctrl', { ctrlKey: true }], ['⌘', { metaKey: true }]])('zooms the document on %s+wheel, and not the whole page', (_label, keys) => {
      const event = wheel({ ...keys, deltaY: -100, clientX: 30, clientY: 40 })

      expect(event.defaultPrevented).toBe(true)
      expect(handlers.onWheelZoom).toHaveBeenCalledWith(-100, { x: 30, y: 40 })
    })

    it('leaves an ordinary wheel to scroll', () => {
      const event = wheel({ deltaY: 100 })

      expect(event.defaultPrevented).toBe(false)
      expect(handlers.onWheelZoom).not.toHaveBeenCalled()
    })
  })

  describe('the keyboard', () => {
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      frameDocument.body.dispatchEvent(event)
      return event
    }

    it.each(['+', '=', '-', '_', '0', '1'])('reports the zoom key %s', (key) => {
      const event = press(key)

      expect(handlers.onZoomKey).toHaveBeenCalledWith(key)
      expect(event.defaultPrevented).toBe(true)
    })

    it.each([['a', {}], ['+', { ctrlKey: true }], ['-', { metaKey: true }], ['0', { altKey: true }]])(
      'leaves %s with %j to the browser',
      (key, init) => {
        press(key, init as KeyboardEventInit)

        expect(handlers.onZoomKey).not.toHaveBeenCalled()
      },
    )
  })

  it('stops listening when detached', () => {
    detach()

    click(anchorWith('https://example.com'))
    frameDocument.body.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 1, bubbles: true, cancelable: true }))
    frameDocument.body.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))

    expect(handlers.onExternalLink).not.toHaveBeenCalled()
    expect(handlers.onWheelZoom).not.toHaveBeenCalled()
    expect(handlers.onZoomKey).not.toHaveBeenCalled()
  })
})

describe('measuring', () => {
  function pages(...widths: string[]) {
    const doc = document.implementation.createHTMLDocument('frame')
    const wrapper = doc.body.appendChild(doc.createElement('div'))
    wrapper.className = 'docx-wrapper'
    for (const width of widths) {
      const section = wrapper.appendChild(doc.createElement('section'))
      section.className = 'docx'
      section.style.width = width
    }
    return doc
  }

  it('reads the widest page from its declared width where nothing has been laid out', () => {
    expect(naturalPageWidth(pages('595.3pt', '842pt'))).toBeCloseTo((842 * 96) / 72, 3)
  })

  it.each([
    ['794px', 794],
    ['8.5in', 816],
    ['21cm', (21 * 96) / 2.54],
    ['210mm', (210 * 96) / 25.4],
    ['612pt', 816],
  ])('understands %s', (width, expected) => {
    expect(naturalPageWidth(pages(width))).toBeCloseTo(expected, 3)
  })

  it('prefers the width the browser laid out to the one the document declared', () => {
    const doc = pages('100pt')
    doc.querySelector('section')!.getBoundingClientRect = () => ({ width: 777 }) as DOMRect

    expect(naturalPageWidth(doc)).toBe(777)
  })

  it('is zero for a document with no pages', () => {
    expect(naturalPageWidth(pages())).toBe(0)
  })

  it('measures the content height to whole pixels, rounding up', () => {
    const doc = document.implementation.createHTMLDocument('frame')
    doc.body.getBoundingClientRect = () => ({ height: 1234.2 }) as DOMRect

    expect(contentHeight(doc)).toBe(1235)
  })
})

describe('presentation', () => {
  it('zooms the wrapper, which holds the pages and their gaps alike', () => {
    const doc = document.implementation.createHTMLDocument('frame')
    const wrapper = doc.body.appendChild(doc.createElement('div'))
    wrapper.className = 'docx-wrapper'

    applyZoom(doc, 1.25)

    expect(wrapper.style.getPropertyValue('--docx-zoom')).toBe('1.25')
    // …which the frame's stylesheet turns into `zoom` on that wrapper.
    expect(presentationCss('white')).toMatch(/\.docx-wrapper\{zoom:var\(--docx-zoom,1\)/)
  })

  it('does nothing for a document that has not been drawn', () => {
    expect(() => applyZoom(document.implementation.createHTMLDocument('frame'), 2)).not.toThrow()
  })

  it('takes the paper colour from the page’s theme', () => {
    document.documentElement.style.setProperty('--color-document-paper', ' #FFFFFF ')

    expect(documentPaperColor()).toBe('#FFFFFF')
  })

  it('has a paper colour even where the page defines none', () => {
    expect(documentPaperColor()).toBe('white')
  })

  it('paints the paper with that colour, and leaves the surround to the page', () => {
    const css = presentationCss('rgb(250, 250, 250)')

    expect(css).toContain('section.docx{background:rgb(250, 250, 250)')
    expect(css).toMatch(/\.docx-wrapper\{[^}]*background:transparent/)
  })

  it('names no colour of its own', () => {
    expect(presentationCss('var(--x)')).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})
