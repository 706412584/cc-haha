import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from './desktopHost/browserHost'

let previewHandler: ((payload: unknown) => void) | null = null

const { prefill, sendMessage, previewMessage } = vi.hoisted(() => ({
  prefill: vi.fn(),
  sendMessage: vi.fn(),
  previewMessage: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      queueComposerPrefill: prefill,
      sendMessage,
    }),
  },
}))

import { subscribePreviewEvents } from './previewEvents'
import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { usePreviewSelectionStore } from '../stores/previewSelectionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

describe('subscribePreviewEvents', () => {
  beforeEach(() => {
    previewHandler = null
    prefill.mockClear()
    sendMessage.mockClear()
    previewMessage.mockClear()
    useBrowserPanelStore.setState({ bySession: {} })
    usePreviewSelectionStore.setState({ bySession: {} })
    useSettingsStore.setState({ locale: 'zh' })
    useUIStore.setState({ toasts: [] })
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        previewWebview: true,
      },
      preview: {
        ...browserHost.preview,
        message: previewMessage,
        onEvent: async (handler) => {
          previewHandler = handler
          return () => {
            previewHandler = null
          }
        },
      },
    }
  })

  it('routes navigated event to the store', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    await subscribePreviewEvents('s1')
    previewHandler!(JSON.stringify({ v: 1, type: 'navigated', url: 'http://x/c', title: 'C' }))
    expect(useBrowserPanelStore.getState().bySession['s1']!.url).toBe('http://x/c')
  })

  it('screenshot event prefills composer with an image attachment', async () => {
    await subscribePreviewEvents('s1')
    previewHandler!({ v: 1, type: 'screenshot', dataUrl: 'data:image/png;base64,AAAA', kind: 'full' })
    expect(prefill).toHaveBeenCalledWith('s1', expect.objectContaining({
      mode: 'append',
      attachments: [expect.objectContaining({ type: 'image', data: 'data:image/png;base64,AAAA' })],
    }))
  })

  it('selection event sends a chat turn directly with hidden prompt text + annotated screenshot', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')
    const payload = { pageUrl: 'http://x/', element: { selector: '#t', tag: 'h1', classes: [] }, change: { description: '改一下' }, screenshot: { dataUrl: 'data:image/png;base64,AAAA', kind: 'element' } }
    previewHandler!(JSON.stringify({ v: 1, type: 'selection', payload }))
    expect(prefill).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('改一下'),
      [expect.objectContaining({
        type: 'image',
        name: '<h1>',
        data: 'data:image/png;base64,AAAA',
        note: '改一下',
      })],
      expect.objectContaining({
        hideDisplayContent: true,
        displayAttachments: [expect.objectContaining({ name: '<h1>', note: '改一下' })],
      }),
    )
  })

  it('accepts the selection that arrives before picker-exited on the confirm path', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')

    // 确认编辑气泡时页面只发 selection；picker-exited 若抢在前面会解除 picker 态并丢弃选区。
    previewHandler!(JSON.stringify({ v: 1, type: 'selection', payload: { pageUrl: 'http://x/', element: { selector: '#t', tag: 'h1', classes: [] }, screenshot: { dataUrl: 'data:image/png;base64,AAAA', kind: 'region' } } }))
    previewHandler!(JSON.stringify({ v: 1, type: 'picker-exited' }))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(false)
  })

  it('ignores selection events when the host picker is not active', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    await subscribePreviewEvents('s1')

    previewHandler!(JSON.stringify({
      v: 1,
      type: 'selection',
      payload: {
        pageUrl: 'http://x/',
        element: { selector: '#forged', tag: 'button', classes: [] },
      },
    }))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(false)
  })

  it('selection event resets pickerActive on the session', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')
    previewHandler!(JSON.stringify({ v: 1, type: 'selection', payload: { pageUrl: 'http://x/', element: { selector: '#t', tag: 'h1', classes: [] }, screenshot: { dataUrl: 'data:image/png;base64,AAAA', kind: 'element' } } }))
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(false)
  })

  it('ignores a malformed selection payload without throwing but still resets picker', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')
    expect(() => previewHandler!(JSON.stringify({ v: 1, type: 'selection', payload: { pageUrl: 'http://x/' } }))).not.toThrow()
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(false)
  })

  it('picker-exited event resets pickerActive', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')
    previewHandler!(JSON.stringify({ v: 1, type: 'picker-exited' }))
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(false)
  })

  it('queues a selection and explicitly rearms the next one without sending chat', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')

    previewHandler!(JSON.stringify({
      v: 1,
      type: 'selection',
      payload: {
        pageUrl: 'http://x/',
        delivery: 'queue',
        draftItemId: 'queued-1',
        element: { selector: '#title', tag: 'h1', classes: [] },
        change: { description: '更轻一点' },
        screenshot: { dataUrl: 'data:image/png;base64,AAAA', kind: 'region' },
      },
    }))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(usePreviewSelectionStore.getState().bySession.s1?.items).toMatchObject([
      { id: 'queued-1', number: 1, payload: { selectionNumber: 1 } },
    ])
    expect(useBrowserPanelStore.getState().bySession.s1?.pickerActive).toBe(true)
    expect(previewMessage).toHaveBeenCalledWith(expect.objectContaining({
      v: 1,
      type: 'enter-picker',
      mode: 'batch',
      label: 2,
    }))
  })

  it('resumes a queued batch after cancelling only the current element', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    usePreviewSelectionStore.getState().add('s1', {
      pageUrl: 'http://x/',
      draftItemId: 'queued-1',
      element: { selector: '#title', tag: 'h1', classes: [] } as never,
    })
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')

    previewHandler!(JSON.stringify({ v: 1, type: 'picker-exited', reason: 'cancel-current' }))

    expect(useBrowserPanelStore.getState().bySession.s1?.pickerActive).toBe(true)
    expect(previewMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'enter-picker',
      mode: 'batch',
      label: 2,
    }))
  })

  it('stops rearming at the batch limit and explains the next action', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    for (let index = 1; index < 5; index += 1) {
      usePreviewSelectionStore.getState().add('s1', {
        pageUrl: 'http://x/',
        draftItemId: `queued-${index}`,
        element: { selector: `#item-${index}`, tag: 'div', classes: [] } as never,
      })
    }
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')

    previewHandler!(JSON.stringify({
      v: 1,
      type: 'selection',
      payload: {
        pageUrl: 'http://x/',
        delivery: 'queue',
        draftItemId: 'queued-5',
        element: { selector: '#item-5', tag: 'div', classes: [] },
      },
    }))

    expect(usePreviewSelectionStore.getState().bySession.s1?.items).toHaveLength(5)
    expect(useBrowserPanelStore.getState().bySession.s1?.pickerActive).toBe(false)
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('已选满 5 个，请先发送或清空本批选择。')
  })

  it('clears a stale batch and warns when the page navigates itself', async () => {
    useBrowserPanelStore.getState().open('s1', 'http://x/a')
    usePreviewSelectionStore.getState().add('s1', {
      pageUrl: 'http://x/a',
      draftItemId: 'queued-1',
      element: { selector: '#title', tag: 'h1', classes: [] } as never,
    })
    useBrowserPanelStore.getState().setPicker('s1', true)
    await subscribePreviewEvents('s1')

    previewHandler!(JSON.stringify({ v: 1, type: 'navigated', url: 'http://x/b', title: 'B' }))

    expect(usePreviewSelectionStore.getState().bySession.s1).toBeUndefined()
    expect(useBrowserPanelStore.getState().bySession.s1?.pickerActive).toBe(false)
    expect(previewMessage).toHaveBeenCalledWith({ v: 1, type: 'clear-selection-draft' })
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('页面已变化，已清空 1 个选择。')
  })
})
