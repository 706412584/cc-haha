import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// 宿主两侧（主进程 pickerArmed、渲染进程 pickerActive）都把 picker-exited 当作
// 「解除本次拾取授权」，并在其后丢弃 selection。这里跑的是真实注入脚本，用来锁住
// 「确认时只发 selection、取消时才发 picker-exited」这条跨进程契约。
type PostedMessage = {
  v: number
  type: string
  payload?: {
    element?: { tag?: string }
    change?: Record<string, unknown>
    delivery?: 'send' | 'queue'
    draftItemId?: string
    selectionNumber?: number
  }
}

const posted: PostedMessage[] = []

type AgentWindow = typeof window & {
  __DESKTOP_PREVIEW_POST__?: (raw: string) => void
  __PREVIEW_BRIDGE__?: { handleHostRaw: (raw: string) => void }
}

const agentWindow = window as AgentWindow

function sendFromHost(message: string | Record<string, unknown>): void {
  const payload = typeof message === 'string' ? { type: message } : message
  agentWindow.__PREVIEW_BRIDGE__!.handleHostRaw(JSON.stringify({ v: 1, ...payload }))
}

function bubbleButton(action: 'confirm' | 'queue' | 'cancel'): HTMLButtonElement {
  for (const host of document.documentElement.querySelectorAll('div')) {
    const button = host.shadowRoot?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
    if (button) return button
  }
  throw new Error(`edit bubble button not found: ${action}`)
}

function pick(el: Element): void {
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

const types = () => posted.map((m) => m.type)

beforeAll(async () => {
  // IIFE 在 import 时立即执行，post 钩子必须先于它挂上（静态 import 会被提升，故用动态 import）
  agentWindow.__DESKTOP_PREVIEW_POST__ = (raw: string) => { posted.push(JSON.parse(raw) as PostedMessage) }
  await import('./index')
})

beforeEach(() => {
  document.body.innerHTML = '<h1 id="t" style="color:rgb(0,0,0)">Old</h1>'
  for (const host of [...document.documentElement.querySelectorAll('div')]) {
    if (host.shadowRoot || host.dataset.previewSelectionAnnotationRoot) host.remove()
  }
  sendFromHost('exit-picker')   // 复位上一个用例可能残留的 picker 态
  sendFromHost('clear-selection-draft')
  posted.length = 0
})

describe('preview agent picker flow', () => {
  it('confirm 发出 selection，且此前不发 picker-exited（否则宿主会丢弃选区）', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)

    bubbleButton('confirm').click()

    expect(types()).toContain('selection')
    const beforeSelection = types().slice(0, types().indexOf('selection'))
    expect(beforeSelection).not.toContain('picker-exited')
  })

  it('confirm 带上编辑内容一起送出选区', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)

    const text = bubbleButton('confirm').getRootNode() as ShadowRoot
    const textInput = text.querySelector<HTMLInputElement>('[data-field="text"]')!
    textInput.value = 'New'
    textInput.dispatchEvent(new Event('input'))
    bubbleButton('confirm').click()

    const selection = posted.find((m) => m.type === 'selection')!
    expect(selection.payload?.element?.tag).toBe('h1')
    expect(selection.payload?.change).toMatchObject({ text: { from: 'Old', to: 'New' } })
  })

  it('cancel 发 picker-exited 解除宿主授权，且不发 selection', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)

    bubbleButton('cancel').click()

    expect(types()).toContain('picker-exited')
    expect(types()).not.toContain('selection')
  })

  it('确认后 picker 停止工作，页面无法再自行送出第二个选区', () => {
    sendFromHost('enter-picker')
    pick(document.getElementById('t')!)
    bubbleButton('confirm').click()
    posted.length = 0

    pick(document.getElementById('t')!)

    expect(types()).not.toContain('selection')
  })

  it('批量添加携带稳定编号，并能按 itemId 撤销页面上的实时预览', () => {
    sendFromHost({ type: 'enter-picker', mode: 'batch', label: 3 })
    const target = document.getElementById('t')!
    pick(target)
    const root = bubbleButton('queue').getRootNode() as ShadowRoot
    const textInput = root.querySelector<HTMLInputElement>('[data-field="text"]')!
    textInput.value = 'Queued'
    textInput.dispatchEvent(new Event('input'))
    bubbleButton('queue').click()

    const selection = posted.find((message) => message.type === 'selection')!
    expect(selection.payload).toMatchObject({
      delivery: 'queue',
      selectionNumber: 3,
      change: { text: { from: 'Old', to: 'Queued' } },
    })
    expect(types()).not.toContain('picker-exited')
    expect(target.textContent).toBe('Queued')

    sendFromHost({ type: 'undo-selection', itemId: selection.payload!.draftItemId! })
    expect(target.textContent).toBe('Old')
  })
})
