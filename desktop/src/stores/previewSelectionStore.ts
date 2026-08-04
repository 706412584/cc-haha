import { create } from 'zustand'
import type { SelectionBatchItem, SelectionPayload } from '../lib/selectionComposer'

export const MAX_PREVIEW_SELECTIONS = 5

export type PreviewSelectionDraft = {
  items: SelectionBatchItem[]
  nextNumber: number
}

type PreviewSelectionStore = {
  bySession: Record<string, PreviewSelectionDraft>
  add: (sessionId: string, payload: SelectionPayload) => SelectionBatchItem | null
  undoLast: (sessionId: string) => SelectionBatchItem | null
  clear: (sessionId: string) => SelectionBatchItem[]
}

const emptyDraft = (): PreviewSelectionDraft => ({ items: [], nextNumber: 1 })

export const usePreviewSelectionStore = create<PreviewSelectionStore>((set, get) => ({
  bySession: {},
  add: (sessionId, payload) => {
    const current = get().bySession[sessionId] ?? emptyDraft()
    if (current.items.length >= MAX_PREVIEW_SELECTIONS) return null

    const item: SelectionBatchItem = {
      id: payload.draftItemId || `selection-${current.nextNumber}`,
      number: current.nextNumber,
      payload: { ...payload, selectionNumber: current.nextNumber },
    }
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: {
          items: [...current.items, item],
          nextNumber: current.nextNumber + 1,
        },
      },
    }))
    return item
  },
  undoLast: (sessionId) => {
    const current = get().bySession[sessionId]
    const item = current?.items.at(-1)
    if (!current || !item) return null
    set((state) => ({
      bySession: {
        ...state.bySession,
        [sessionId]: { ...current, items: current.items.slice(0, -1) },
      },
    }))
    return item
  },
  clear: (sessionId) => {
    const current = get().bySession[sessionId]
    if (!current) return []
    const bySession = { ...get().bySession }
    delete bySession[sessionId]
    set({ bySession })
    return current.items
  },
}))
