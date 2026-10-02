import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWorkspaceContentStore, workspaceFileKey } from '@/stores/workspaceContentStore'
import { openLocalFileWithSystem, reportOpenFailure } from '@/lib/systemFileOpen'
import { ImagePreview } from './ImagePreview'

vi.mock('@/lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn(),
  reportOpenFailure: vi.fn(),
}))

const dataUrl = 'data:image/png;base64,iVBORwoKGgo='

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
const originalNaturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth')
const originalNaturalHeight = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalHeight')

function stubGeometry() {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 1600 })
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 1200 })
}

function restore(property: string, target: object, original: PropertyDescriptor | undefined) {
  if (original) Object.defineProperty(target, property, original)
  else Reflect.deleteProperty(target, property)
}

function loaded(image: HTMLElement) {
  act(() => { fireEvent.load(image) })
}

describe('ImagePreview', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useWorkspaceContentStore.setState({ fileViewByKey: {} })
    vi.mocked(openLocalFileWithSystem).mockReset().mockResolvedValue(undefined)
    vi.mocked(reportOpenFailure).mockReset()
  })

  afterEach(() => {
    restore('clientWidth', HTMLElement.prototype, originalClientWidth)
    restore('clientHeight', HTMLElement.prototype, originalClientHeight)
    restore('naturalWidth', HTMLImageElement.prototype, originalNaturalWidth)
    restore('naturalHeight', HTMLImageElement.prototype, originalNaturalHeight)
  })

  it('renders the decoded image and names it with the file path', () => {
    render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" />)

    const image = screen.getByRole('img', { name: 'assets/logo.png' })
    expect(image).toHaveAttribute('src', dataUrl)
  })

  it('shows the load error instead of an empty frame when there is no image data', () => {
    render(<ImagePreview path="assets/logo.png" error="File is too large" />)

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('File is too large')
  })

  it('falls back to the generic message when the failure carried no reason', () => {
    render(<ImagePreview path="assets/logo.png" />)

    expect(screen.getByRole('status')).toHaveTextContent('Image preview is unavailable.')
  })

  it('offers the zoom controls, in the viewer language', () => {
    render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" />)

    for (const name of ['Zoom in', 'Zoom out', 'Fit to window']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  describe('coming back to a zoomed picture', () => {
    const left = { scrollTop: 80, scrollLeft: 120, zoom: 2 }

    it('scrolls it back to where it was left, once it has loaded and has a size to scroll', () => {
      stubGeometry()
      useWorkspaceContentStore.setState({ fileViewByKey: { [workspaceFileKey('s1', 'assets/logo.png')]: left } })
      render(<ImagePreview sessionId="s1" dataUrl={dataUrl} path="assets/logo.png" initialView={left} />)
      const area = screen.getByRole('group', { name: 'assets/logo.png' })
      // The workspace restores what it can, and restoring before the picture is laid out
      // at its zoom would clamp to 0 and record the 0: so it is left to the picture.
      expect(area).toHaveAttribute('data-workspace-scroll-surface', 'deferred')
      expect(area.scrollTop).toBe(0)

      loaded(screen.getByRole('img', { name: 'assets/logo.png' }))

      expect(area.scrollTop).toBe(80)
      expect(area.scrollLeft).toBe(120)
    })

    it('has nothing to restore for a picture that was never left, or that keeps no view', () => {
      stubGeometry()
      const { unmount } = render(<ImagePreview sessionId="s1" dataUrl={dataUrl} path="assets/logo.png" />)
      expect(screen.getByRole('group', { name: 'assets/logo.png' })).toHaveAttribute('data-workspace-scroll-surface', '')
      unmount()

      render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" initialView={left} />)
      expect(screen.getByRole('group', { name: 'assets/logo.png' })).toHaveAttribute('data-workspace-scroll-surface', '')
    })
  })

  describe('system app', () => {
    it('hands the original file to the operating system', () => {
      render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" absolutePath="/work/assets/logo.png" />)

      fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))

      expect(openLocalFileWithSystem).toHaveBeenCalledWith('/work/assets/logo.png')
    })

    it('says which file could not be opened instead of failing silently', async () => {
      vi.mocked(openLocalFileWithSystem).mockRejectedValue(new Error('no application'))
      render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" absolutePath="/work/assets/logo.png" />)

      fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))

      await waitFor(() => expect(reportOpenFailure).toHaveBeenCalledWith('/work/assets/logo.png'))
    })

    it('shows no such action without an absolute path to open', () => {
      render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" />)

      expect(screen.queryByRole('button', { name: 'Open in system app' })).not.toBeInTheDocument()
    })
  })

  it('replaces a picture that cannot be decoded with the unavailable message and a way out', () => {
    render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" absolutePath="/work/assets/logo.png" />)

    fireEvent.error(screen.getByRole('img', { name: 'assets/logo.png' }))

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Image preview is unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))
    expect(openLocalFileWithSystem).toHaveBeenCalledWith('/work/assets/logo.png')
  })

  it('forgets a decode failure when the file changes to one that does decode', () => {
    const { rerender } = render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" />)
    fireEvent.error(screen.getByRole('img', { name: 'assets/logo.png' }))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    rerender(<ImagePreview dataUrl="data:image/png;base64,AAAA" path="assets/logo.png" />)

    expect(screen.getByRole('img', { name: 'assets/logo.png' })).toBeInTheDocument()
  })

  describe('zoom persistence', () => {
    beforeEach(stubGeometry)

    it('keeps the zoom across a remount, which is what a tab switch does', () => {
      const props = { sessionId: 's1', dataUrl, path: 'assets/logo.png' }
      const first = render(<ImagePreview {...props} />)
      loaded(screen.getByRole('img'))

      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
      expect(screen.getByText('50%')).toBeInTheDocument()
      expect(useWorkspaceContentStore.getState().fileViewByKey[workspaceFileKey('s1', 'assets/logo.png')]?.zoom).toBe(0.5)
      first.unmount()

      render(<ImagePreview {...props} />)
      loaded(screen.getByRole('img'))

      expect(screen.getByText('50%')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Fit to window' })).toBeEnabled()
    })

    it('stores fit as the absence of a zoom, so the default keeps following the panel size', () => {
      render(<ImagePreview sessionId="s1" dataUrl={dataUrl} path="assets/logo.png" />)
      loaded(screen.getByRole('img'))
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

      fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }))

      expect(useWorkspaceContentStore.getState().fileViewByKey[workspaceFileKey('s1', 'assets/logo.png')]?.zoom).toBeUndefined()
      expect(screen.getByRole('button', { name: 'Fit to window' })).toBeDisabled()
    })

    it('keeps the scroll position stored beside the zoom', () => {
      useWorkspaceContentStore.getState().setFileView('s1', 'assets/logo.png', { scrollTop: 40, scrollLeft: 8 })
      render(<ImagePreview sessionId="s1" dataUrl={dataUrl} path="assets/logo.png" />)
      loaded(screen.getByRole('img'))

      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

      expect(useWorkspaceContentStore.getState().fileViewByKey[workspaceFileKey('s1', 'assets/logo.png')]).toMatchObject({
        scrollTop: 40,
        scrollLeft: 8,
        zoom: 0.5,
      })
    })

    it('keeps the zoom to itself when it has no session to remember it in', () => {
      render(<ImagePreview dataUrl={dataUrl} path="assets/logo.png" />)
      loaded(screen.getByRole('img'))

      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

      expect(screen.getByText('50%')).toBeInTheDocument()
      expect(useWorkspaceContentStore.getState().fileViewByKey).toEqual({})
    })
  })
})
