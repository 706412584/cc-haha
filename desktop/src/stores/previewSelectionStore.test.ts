import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_PREVIEW_SELECTIONS, usePreviewSelectionStore } from './previewSelectionStore'

function payload(id: string) {
  return {
    pageUrl: 'http://localhost:5173/',
    draftItemId: id,
    element: { selector: `#${id}`, tag: 'div', classes: [] },
  } as never
}

describe('previewSelectionStore', () => {
  beforeEach(() => usePreviewSelectionStore.setState({ bySession: {} }))

  it('keeps selection numbers stable across undo and subsequent additions', () => {
    const store = usePreviewSelectionStore.getState()
    expect(store.add('s1', payload('one'))?.number).toBe(1)
    expect(store.add('s1', payload('two'))?.number).toBe(2)
    expect(store.undoLast('s1')?.id).toBe('two')
    expect(store.add('s1', payload('three'))?.number).toBe(3)
    expect(usePreviewSelectionStore.getState().bySession.s1?.items.map((item) => item.number)).toEqual([1, 3])
  })

  it('caps a batch without replacing an existing selection', () => {
    const store = usePreviewSelectionStore.getState()
    for (let index = 0; index < MAX_PREVIEW_SELECTIONS; index += 1) {
      expect(store.add('s1', payload(`item-${index}`))).not.toBeNull()
    }
    expect(store.add('s1', payload('overflow'))).toBeNull()
    expect(usePreviewSelectionStore.getState().bySession.s1?.items).toHaveLength(MAX_PREVIEW_SELECTIONS)
  })
})
