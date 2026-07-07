import { applyEdit, type EditDiff, type EditInput } from './popover'

export type EditableSnapshot = { text: string; color: string; background: string; opacity: string; fontFamily: string }
export type EditBubbleChange = EditDiff & { description?: string }
type Deps = { onConfirm: (change: EditBubbleChange) => void; onCancel: () => void }

const VIEWPORT_MARGIN = 8
const BUBBLE_GAP = 8
const BUBBLE_WIDTH = 340
const BUBBLE_ESTIMATED_HEIGHT = 380
const BUBBLE_MIN_HEIGHT = 160

const FIELDS: Array<{ key: keyof EditableSnapshot; label: string }> = [
  { key: 'text', label: '文本' },
  { key: 'color', label: '文字颜色' },
  { key: 'background', label: '背景' },
  { key: 'opacity', label: 'Opacity' },
  { key: 'fontFamily', label: '字体' },
]

export function snapshotEditableStyles(el: HTMLElement): EditableSnapshot {
  const cs = window.getComputedStyle(el)
  return {
    text: el.textContent ?? '',
    color: cs.color,
    background: cs.backgroundColor,
    opacity: cs.opacity,
    fontFamily: cs.fontFamily,
  }
}

export function computeChange(original: EditableSnapshot, current: EditableSnapshot): EditDiff {
  const d: EditDiff = {}
  if (current.text !== original.text) d.text = { from: original.text, to: current.text }
  if (current.color !== original.color) d.color = { from: original.color, to: current.color }
  if (current.background !== original.background) d.background = { from: original.background, to: current.background }
  if (current.opacity !== original.opacity) d.opacity = { from: original.opacity, to: current.opacity }
  if (current.fontFamily !== original.fontFamily) d.fontFamily = { from: original.fontFamily, to: current.fontFamily }
  return d
}

function buildPatch(key: keyof EditableSnapshot, value: string): EditInput {
  const patch: EditInput = {}
  if (key === 'text') patch.text = value
  else if (key === 'color') patch.color = value
  else if (key === 'background') patch.background = value
  else if (key === 'opacity') patch.opacity = value
  else if (key === 'fontFamily') patch.fontFamily = value
  return patch
}

function computeBubbleLayout(rect: DOMRect, contentHeight: number) {
  const viewportWidth = Math.max(window.innerWidth || 0, BUBBLE_WIDTH + VIEWPORT_MARGIN * 2)
  const viewportHeight = Math.max(window.innerHeight || 0, BUBBLE_MIN_HEIGHT + VIEWPORT_MARGIN * 2)
  const desiredHeight = Math.min(
    Math.max(Math.ceil(contentHeight) || BUBBLE_ESTIMATED_HEIGHT, BUBBLE_MIN_HEIGHT),
    Math.max(BUBBLE_MIN_HEIGHT, viewportHeight - VIEWPORT_MARGIN * 2),
  )
  const belowTop = rect.bottom + BUBBLE_GAP
  const spaceBelow = viewportHeight - VIEWPORT_MARGIN - belowTop
  const spaceAbove = rect.top - BUBBLE_GAP - VIEWPORT_MARGIN
  let top: number

  if (spaceBelow >= desiredHeight) {
    top = belowTop
  } else if (spaceAbove >= desiredHeight) {
    top = rect.top - BUBBLE_GAP - desiredHeight
  } else if (spaceAbove > spaceBelow) {
    top = VIEWPORT_MARGIN
  } else {
    top = Math.min(Math.max(belowTop, VIEWPORT_MARGIN), viewportHeight - VIEWPORT_MARGIN - BUBBLE_MIN_HEIGHT)
  }

  top = Math.max(VIEWPORT_MARGIN, Math.round(top))
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - BUBBLE_WIDTH - VIEWPORT_MARGIN)
  const left = Math.max(VIEWPORT_MARGIN, Math.min(Math.round(rect.left), maxLeft))
  const maxHeight = Math.max(BUBBLE_MIN_HEIGHT, viewportHeight - VIEWPORT_MARGIN - top)
  return { top, left, maxHeight }
}

export function createEditBubble(el: HTMLElement, deps: Deps): { host: HTMLElement; destroy: () => void } {
  const original = snapshotEditableStyles(el)
  const current: EditableSnapshot = { ...original }
  let description = ''

  const host = document.createElement('div')
  const rect = el.getBoundingClientRect()
  host.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;visibility:hidden'
  const shadow = host.attachShadow({ mode: 'open' })

  const wrap = document.createElement('div')
  wrap.setAttribute('style', 'width:340px;box-sizing:border-box;background:#fff;border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.2);padding:12px;font:13px/1.45 -apple-system,system-ui,sans-serif;color:#111;display:flex;flex-direction:column;overflow:hidden')

  const body = document.createElement('div')
  body.setAttribute('style', 'min-height:0;overflow:auto')

  const desc = document.createElement('input')
  desc.setAttribute('data-field', 'description')
  desc.placeholder = '描述这些更改…'
  desc.setAttribute('style', 'width:100%;box-sizing:border-box;border:none;outline:none;font-size:14px;padding:6px 4px')
  desc.addEventListener('input', () => { description = desc.value })
  body.appendChild(desc)

  const tag = document.createElement('div')
  tag.textContent = el.tagName.toLowerCase()
  tag.setAttribute('style', 'color:#8a8a8a;border-top:1px solid #eee;margin-top:6px;padding:8px 4px 4px;font-weight:600')
  body.appendChild(tag)

  for (const f of FIELDS) {
    const row = document.createElement('label')
    row.setAttribute('style', 'display:flex;align-items:center;gap:10px;padding:5px 4px')
    const lab = document.createElement('span')
    lab.textContent = f.label
    lab.setAttribute('style', 'width:74px;color:#555;flex:none')
    const inp = document.createElement('input')
    inp.setAttribute('data-field', f.key)
    inp.value = original[f.key]
    inp.setAttribute('style', 'flex:1;min-width:0;border:1px solid #e2e2e2;border-radius:8px;padding:5px 9px;font:inherit')
    const fieldKey = f.key
    inp.addEventListener('input', () => {
      current[fieldKey] = inp.value
      applyEdit(el, buildPatch(fieldKey, inp.value))
    })
    row.appendChild(lab)
    row.appendChild(inp)
    body.appendChild(row)
  }

  const footer = document.createElement('div')
  footer.setAttribute('data-region', 'footer')
  footer.setAttribute('style', 'display:flex;justify-content:space-between;align-items:center;margin-top:12px')
  const cancelBtn = document.createElement('button')
  cancelBtn.setAttribute('data-action', 'cancel')
  cancelBtn.textContent = '取消'
  cancelBtn.setAttribute('style', 'border:none;background:#f1f1f1;border-radius:18px;padding:7px 16px;cursor:pointer;font:inherit')
  const confirmBtn = document.createElement('button')
  confirmBtn.setAttribute('data-action', 'confirm')
  confirmBtn.textContent = '✓'
  confirmBtn.setAttribute('style', 'border:none;background:#2f7bff;color:#fff;border-radius:50%;width:34px;height:34px;cursor:pointer;font-size:16px')

  cancelBtn.addEventListener('click', () => {
    applyEdit(el, original)
    deps.onCancel()
  })
  confirmBtn.addEventListener('click', () => {
    deps.onConfirm({ ...computeChange(original, current), description: description || undefined })
  })

  footer.appendChild(cancelBtn)
  footer.appendChild(confirmBtn)
  wrap.appendChild(body)
  wrap.appendChild(footer)
  shadow.appendChild(wrap)
  document.documentElement.appendChild(host)
  const measuredHeight = wrap.getBoundingClientRect().height || wrap.scrollHeight || BUBBLE_ESTIMATED_HEIGHT
  const layout = computeBubbleLayout(rect, measuredHeight)
  host.style.top = `${layout.top}px`
  host.style.left = `${layout.left}px`
  host.style.visibility = 'visible'
  wrap.style.maxHeight = `${layout.maxHeight}px`

  return { host, destroy: () => { host.remove() } }
}
