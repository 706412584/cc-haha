import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openLocalFileWithSystem, reportOpenFailure } from '@/lib/systemFileOpen'
import { useSettingsStore } from '@/stores/settingsStore'
import { DocumentToolbar, type DocumentZoomState } from './DocumentToolbar'

vi.mock('@/lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn(),
  reportOpenFailure: vi.fn(),
}))

function zoomState(overrides: Partial<DocumentZoomState> = {}): DocumentZoomState {
  return {
    percent: 100,
    fitActive: true,
    canZoomIn: true,
    canZoomOut: true,
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onFit: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  vi.mocked(openLocalFileWithSystem).mockReset().mockResolvedValue(undefined)
  vi.mocked(reportOpenFailure).mockReset()
})

describe('DocumentToolbar', () => {
  it('shows what is specific to the document kind on the left', () => {
    render(<DocumentToolbar leading={<span>3 / 12</span>} absolutePath="/work/a.pdf" />)

    expect(screen.getByText('3 / 12')).toBeInTheDocument()
  })

  it('offers zoom in the viewer language, and fits to the width of a document', () => {
    const zoom = zoomState({ percent: 110, fitActive: false })
    render(<DocumentToolbar zoom={zoom} absolutePath="/work/a.pdf" />)

    expect(screen.getByText('110%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    // A page reads top to bottom: "fit" means the width, not the whole page.
    const fit = screen.getByRole('button', { name: 'Fit to width' })
    expect(fit.querySelector('svg')).toHaveClass('lucide-move-horizontal')
    fireEvent.click(fit)

    expect(zoom.onZoomIn).toHaveBeenCalledTimes(1)
    expect(zoom.onZoomOut).toHaveBeenCalledTimes(1)
    expect(zoom.onFit).toHaveBeenCalledTimes(1)
  })

  it('draws the zoom cluster flat: it sits in a bar, it does not float over content', () => {
    render(<DocumentToolbar zoom={zoomState()} absolutePath="/work/a.pdf" />)

    expect(screen.getByRole('group', { name: 'Zoom controls' }).className).not.toContain('--shadow-card')
  })

  it('has no zoom controls for a document with nothing to zoom', () => {
    render(<DocumentToolbar absolutePath="/work/a.xlsx" />)

    expect(screen.queryByRole('group', { name: 'Zoom controls' })).not.toBeInTheDocument()
  })

  describe('the way out to the system app', () => {
    it('hands the original file to the operating system', () => {
      render(<DocumentToolbar absolutePath="/work/out/thesis.pdf" />)

      fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))

      expect(openLocalFileWithSystem).toHaveBeenCalledWith('/work/out/thesis.pdf')
    })

    it('names the file it could not open instead of failing silently', async () => {
      vi.mocked(openLocalFileWithSystem).mockRejectedValue(new Error('no application'))
      render(<DocumentToolbar absolutePath="/work/out/thesis.pdf" />)

      fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))

      await waitFor(() => expect(reportOpenFailure).toHaveBeenCalledWith('/work/out/thesis.pdf'))
    })

    it.each(['out/thesis.pdf', ''])('is not offered for %j, which the OS could not resolve', (path) => {
      render(<DocumentToolbar absolutePath={path} />)

      expect(screen.queryByRole('button', { name: 'Open in system app' })).not.toBeInTheDocument()
    })

    it.each(['/work/a.pdf', 'C:\\work\\a.pdf', '~/a.pdf'])('is offered for the rooted path %s', (path) => {
      render(<DocumentToolbar absolutePath={path} />)

      expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
    })
  })

  it('says what a preview leaves out, in full on hover', () => {
    const note = 'Approximate preview: equations and some shapes may not appear.'
    render(<DocumentToolbar absolutePath="/work/a.docx" note={note} />)

    expect(screen.getByText(note)).toHaveAttribute('title', note)
  })

  it('shows no note row when there is nothing to say', () => {
    const { container } = render(<DocumentToolbar absolutePath="/work/a.pdf" />)

    expect(container.querySelector('p')).toBeNull()
  })
})
