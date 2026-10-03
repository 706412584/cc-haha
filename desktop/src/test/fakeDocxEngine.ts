import { vi } from 'vitest'
import type { DocxEngine, DocxRenderTarget } from '@/components/workspace/surfaces/document/docxEngine'

/** One page as docx-preview draws it: a section with its width declared inline. */
export type FakeDocxPage = {
  width: string
  text: string
  /** Markup to put in the page after its text: links, as a document's own would be. */
  html?: string
}

/** One `render` call, for a test to finish or fail when it chooses. */
export type FakeDocxRender = {
  bytes: Uint8Array
  target: DocxRenderTarget
  finish: () => void
  fail: (error: unknown) => void
}

export const A4_PAGE: FakeDocxPage = { width: '600px', text: 'A page of the document' }

/**
 * A Word engine a test can drive. It draws what docx-preview draws — a `.docx-wrapper` of
 * `section.docx` pages, and a `<style>` in the styles container — but only when the test says
 * the render is done, which is what lets it assert on the state in between (the previous
 * version still on show, the next one drawn out of sight).
 *
 * `autoFinish` draws at once, for the tests that only care about what ends up on screen.
 */
export function createFakeDocxEngine({
  pages = [A4_PAGE],
  autoFinish = false,
}: { pages?: FakeDocxPage[]; autoFinish?: boolean } = {}) {
  const renders: FakeDocxRender[] = []

  const draw = (target: DocxRenderTarget, into: FakeDocxPage[]) => {
    const doc = target.body.ownerDocument
    const wrapper = doc.createElement('div')
    wrapper.className = 'docx-wrapper'
    for (const page of into) {
      const section = doc.createElement('section')
      section.className = 'docx'
      section.style.width = page.width
      const paragraph = doc.createElement('p')
      paragraph.textContent = page.text
      section.append(paragraph)
      if (page.html) section.insertAdjacentHTML('beforeend', page.html)
      wrapper.append(section)
    }
    target.body.append(wrapper)
    const style = doc.createElement('style')
    style.textContent = '.docx-wrapper{background:gray}'
    target.styles.append(style)
  }

  const engine: DocxEngine & { render: ReturnType<typeof vi.fn> } = {
    render: vi.fn((bytes: Uint8Array, target: DocxRenderTarget) => new Promise<void>((resolve, reject) => {
      const render: FakeDocxRender = {
        bytes,
        target,
        finish: () => {
          draw(target, pages)
          resolve()
        },
        fail: reject,
      }
      renders.push(render)
      if (autoFinish) render.finish()
    })),
  }
  return { engine, renders }
}
