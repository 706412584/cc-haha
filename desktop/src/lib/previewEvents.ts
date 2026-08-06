import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { useChatStore } from '../stores/chatStore'
import { MAX_PREVIEW_SELECTIONS, usePreviewSelectionStore } from '../stores/previewSelectionStore'
import { useUIStore } from '../stores/uiStore'
import { t } from '../i18n'
import { getDesktopHost } from './desktopHost'
import { buildSelectionDirectMessage, type SelectionPayload } from './selectionComposer'
import { previewBridge } from './previewBridge'
import { buildPreviewPickerMessage } from './previewSelectionPicker'

function kindLabel(kind?: string): string {
  if (kind === 'viewport') return 'viewport'
  if (kind === 'element') return 'element'
  return 'full'
}

export async function subscribePreviewEvents(sessionId: string): Promise<() => void> {
  const host = getDesktopHost()
  if (!host.capabilities.previewWebview) return () => {}

  return host.preview.onEvent((payload) => {
    let msg: {
      type?: string
      url?: string
      title?: string
      dataUrl?: string
      kind?: string
      reason?: string
      payload?: unknown
    }
    try {
      msg = typeof payload === 'string'
        ? JSON.parse(payload)
        : payload as typeof msg
    } catch { return }
    const store = useBrowserPanelStore.getState()
    if (msg.type === 'navigated' && msg.url) {
      // A page navigation destroys the injected agent and its reversible live edits,
      // so a draft from the previous document must never follow the new page.
      const discardedCount = usePreviewSelectionStore.getState().bySession[sessionId]?.items.length ?? 0
      if (discardedCount > 0) {
        void previewBridge.message({ v: 1, type: 'clear-selection-draft' })
        useUIStore.getState().addToast({
          type: 'warning',
          message: t('browser.selection.navigationDiscarded', { count: discardedCount }),
        })
      }
      usePreviewSelectionStore.getState().clear(sessionId)
      store.setPicker(sessionId, false)
      store.setNavigated(sessionId, msg.url, msg.title ?? '')
    }
    else if (msg.type === 'ready') store.setReady(sessionId)
    else if (msg.type === 'screenshot' && msg.dataUrl) {
      useChatStore.getState().queueComposerPrefill(sessionId, {
        text: '',
        mode: 'append',
        attachments: [{ type: 'image', name: `screenshot-${kindLabel(msg.kind)}.png`, mimeType: 'image/png', data: msg.dataUrl }],
      })
    }
    else if (msg.type === 'selection') {
      if (!store.bySession[sessionId]?.pickerActive) return
      // 选区事件意味着页面侧已结束一次性拾取——同步关闭宿主侧 picker 态，避免按钮卡在按下态
      store.setPicker(sessionId, false)
      const p = msg.payload as SelectionPayload | undefined
      if (!p || typeof p !== 'object' || !p.element) return
      if (p.delivery === 'queue') {
        const item = usePreviewSelectionStore.getState().add(sessionId, p)
        if (!item) return
        const draft = usePreviewSelectionStore.getState().bySession[sessionId]!
        if (draft.items.length < MAX_PREVIEW_SELECTIONS) {
          store.setPicker(sessionId, true)
          void previewBridge.message(buildPreviewPickerMessage('batch', draft.nextNumber))
        } else {
          useUIStore.getState().addToast({
            type: 'info',
            message: t('browser.selection.limitReached', { count: MAX_PREVIEW_SELECTIONS }),
          })
        }
        return
      }
      const selection = buildSelectionDirectMessage(p)
      const attachments = p.screenshot?.dataUrl
        ? [{
            type: 'image' as const,
            name: selection.displayName,
            mimeType: 'image/png',
            data: p.screenshot.dataUrl,
            note: selection.note,
            quote: p.element.selector,
          }]
        : []
      useChatStore.getState().sendMessage(sessionId, selection.modelText, attachments, {
        displayContent: selection.displayName,
        displayAttachments: attachments,
        hideDisplayContent: attachments.length > 0,
      })
    }
    else if (msg.type === 'picker-exited') {
      store.setPicker(sessionId, false)
      const draft = usePreviewSelectionStore.getState().bySession[sessionId]
      if (msg.reason === 'cancel-current' && draft?.items.length) {
        store.setPicker(sessionId, true)
        void previewBridge.message(buildPreviewPickerMessage('batch', draft.nextNumber))
      }
    }
    else if (msg.type === 'error') {
      console.warn('[preview-agent]', msg)
    }
  })
}
