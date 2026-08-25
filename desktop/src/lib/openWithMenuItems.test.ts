import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getTargetsForPath = vi.hoisted(() => vi.fn())
vi.mock('../stores/openTargetStore', () => ({
  useOpenTargetStore: {
    getState: () => ({ getTargetsForPath, openTarget: vi.fn(), editorTargetId: null }),
  },
}))

vi.mock('./desktopRuntime', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

import { buildOpenWithMenuItemsForHref } from './openWithMenuItems'
import { useUIStore } from '../stores/uiStore'

const t = (key: string, vars?: Record<string, string>) => (
  vars ? `${key}:${Object.values(vars).join(',')}` : key
)

describe('buildOpenWithMenuItemsForHref', () => {
  beforeEach(() => {
    getTargetsForPath.mockReset()
    useUIStore.setState({ toasts: [] })
  })

  afterEach(() => {
    useUIStore.setState({ toasts: [] })
  })

  it('says which file could not be opened instead of quietly not opening a menu', async () => {
    // A deliverable card carries a path taken from prose, so it can outlive the
    // file. The server refuses a path that is not there; that rejection used to
    // land in a floating promise and the click did nothing at all.
    getTargetsForPath.mockRejectedValue(new Error('Path does not exist: /w/gone.xlsx'))

    const items = await buildOpenWithMenuItemsForHref('gone.xlsx', {
      sessionId: 's1',
      workDir: '/w',
      t,
    })

    expect(items).toEqual([])
    // The real string, so the assertion covers the copy actually reaching the user
    // with the file named — not just that some toast was queued.
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      type: 'error',
      message: 'Could not open gone.xlsx. The file may have been moved or deleted.',
    })
  })

  it('builds the menu and stays quiet when the path resolves', async () => {
    getTargetsForPath.mockResolvedValue([
      { id: 'system-default', kind: 'system_default', label: 'System default', icon: 'system', platform: 'darwin' },
      { id: 'finder', kind: 'file_manager', label: 'Finder', icon: 'finder', platform: 'darwin' },
    ])

    const items = await buildOpenWithMenuItemsForHref('report.xlsx', {
      sessionId: 's1',
      workDir: '/w',
      t,
    })

    expect(items.map((item) => item.id)).toContain('system')
    expect(items.map((item) => item.id)).toContain('fm:finder')
    expect(useUIStore.getState().toasts).toEqual([])
  })

  it('does not consult the server for a URL reference', async () => {
    const items = await buildOpenWithMenuItemsForHref('https://example.com', {
      sessionId: 's1',
      t,
    })

    expect(items.map((item) => item.id)).toEqual(['in-app', 'system'])
    expect(getTargetsForPath).not.toHaveBeenCalled()
    expect(useUIStore.getState().toasts).toEqual([])
  })
})
