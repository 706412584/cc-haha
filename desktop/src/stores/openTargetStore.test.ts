import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  listForPath: vi.fn(),
  open: vi.fn(),
}))

vi.mock('../api/openTargets', () => ({
  openTargetsApi: apiMocks,
}))

describe('openTargetStore', () => {
  beforeEach(async () => {
    vi.resetModules()
    apiMocks.list.mockReset()
    apiMocks.listForPath.mockReset()
    apiMocks.open.mockReset()
  })

  it('caches detected targets inside the TTL', async () => {
    const { useOpenTargetStore } = await import('./openTargetStore')
    apiMocks.list.mockResolvedValue({
      platform: 'darwin',
      targets: [{ id: 'finder', kind: 'file_manager', label: 'Finder', icon: 'finder', platform: 'darwin' }],
      primaryTargetId: 'finder',
      cachedAt: 1,
      ttlMs: 60_000,
    })

    await useOpenTargetStore.getState().refreshTargets()
    await useOpenTargetStore.getState().ensureTargets()

    expect(apiMocks.list).toHaveBeenCalledTimes(1)
    expect(useOpenTargetStore.getState().primaryTargetId).toBe('finder')
  })

  it('remembers the last successful target for this runtime', async () => {
    const { useOpenTargetStore } = await import('./openTargetStore')
    apiMocks.list.mockResolvedValue({
      platform: 'darwin',
      targets: [{ id: 'vscode', kind: 'ide', label: 'VS Code', icon: 'vscode', platform: 'darwin' }],
      primaryTargetId: 'vscode',
      cachedAt: 1,
      ttlMs: 60_000,
    })
    apiMocks.open.mockResolvedValue({ ok: true, targetId: 'vscode', path: '/repo' })

    await useOpenTargetStore.getState().refreshTargets()
    await useOpenTargetStore.getState().openTarget('vscode', '/repo')

    expect(useOpenTargetStore.getState().lastSuccessfulTargetId).toBe('vscode')
  })

  it('falls back to no preferred editor when nothing was ever stored', async () => {
    // The key is new, so every existing installation reads it missing. That has
    // to be an ordinary "not configured", never an error.
    const { useOpenTargetStore, readOpenTargetPreferences } = await import('./openTargetStore')

    expect(readOpenTargetPreferences()).toEqual({ version: 1, editorTargetId: null })
    expect(useOpenTargetStore.getState().editorTargetId).toBeNull()
  })

  it('falls back when the stored preference is unreadable rather than throwing', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{ not json')
    try {
      const { readOpenTargetPreferences } = await import('./openTargetStore')
      expect(readOpenTargetPreferences()).toEqual({ version: 1, editorTargetId: null })
    } finally {
      getItem.mockRestore()
    }
  })

  it('round-trips the preferred editor through storage', async () => {
    const store = new Map<string, string>()
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
      .mockImplementation((key) => store.get(key) ?? null)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => { store.set(key, value) })
    try {
      const { useOpenTargetStore, readOpenTargetPreferences } = await import('./openTargetStore')

      useOpenTargetStore.getState().setEditorTargetId('sublime')

      expect(useOpenTargetStore.getState().editorTargetId).toBe('sublime')
      expect(readOpenTargetPreferences()).toEqual({ version: 1, editorTargetId: 'sublime' })
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('queries targets for the concrete path without replacing project targets', async () => {
    const { useOpenTargetStore } = await import('./openTargetStore')
    apiMocks.listForPath.mockResolvedValue({
      targets: [{ id: 'application:pages', kind: 'application', label: 'Pages', icon: 'application', platform: 'darwin' }],
    })

    await expect(useOpenTargetStore.getState().getTargetsForPath('/tmp/brief.docx'))
      .resolves.toMatchObject([{ kind: 'application', label: 'Pages' }])
    expect(apiMocks.listForPath).toHaveBeenCalledWith('/tmp/brief.docx')
  })
})
