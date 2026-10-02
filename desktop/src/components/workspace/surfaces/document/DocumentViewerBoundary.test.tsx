import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { reportReactError } from '@/lib/diagnosticsCapture'
import { DocumentViewerBoundary } from './DocumentViewerBoundary'

vi.mock('@/lib/diagnosticsCapture', () => ({
  reportReactError: vi.fn(),
}))

function Viewer({ crashes }: { crashes: boolean }) {
  if (crashes) throw new Error('cannot draw this')
  return <div>drawn</div>
}

const fallback = <div role="alert">could not be shown</div>

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  vi.mocked(reportReactError).mockClear()
  // React reports a render error it has caught to the console as well.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('DocumentViewerBoundary', () => {
  it('shows the viewer while it draws', () => {
    render(<DocumentViewerBoundary resetKey="a" fallback={fallback}><Viewer crashes={false} /></DocumentViewerBoundary>)

    expect(screen.getByText('drawn')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the fallback in its place when the viewer throws, instead of letting it reach the window', () => {
    render(<DocumentViewerBoundary resetKey="a" fallback={fallback}><Viewer crashes /></DocumentViewerBoundary>)

    expect(screen.getByRole('alert')).toHaveTextContent('could not be shown')
    expect(screen.queryByText('drawn')).not.toBeInTheDocument()
  })

  it('records the failure in the diagnostics, where it can be found', () => {
    render(<DocumentViewerBoundary resetKey="a" fallback={fallback}><Viewer crashes /></DocumentViewerBoundary>)

    expect(reportReactError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reportReactError).mock.calls[0]![0]).toMatchObject({ message: 'cannot draw this' })
  })

  it('stays failed while nothing about what it shows has changed', () => {
    const { rerender } = render(<DocumentViewerBoundary resetKey="a" fallback={fallback}><Viewer crashes /></DocumentViewerBoundary>)

    rerender(<DocumentViewerBoundary resetKey="a" fallback={fallback}><Viewer crashes={false} /></DocumentViewerBoundary>)

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('drawn')).not.toBeInTheDocument()
  })

  it('tries the viewer again once the key changes, which is what another document or another attempt is', () => {
    const { rerender } = render(<DocumentViewerBoundary resetKey="a" fallback={fallback}><Viewer crashes /></DocumentViewerBoundary>)

    rerender(<DocumentViewerBoundary resetKey="b" fallback={fallback}><Viewer crashes={false} /></DocumentViewerBoundary>)

    expect(screen.getByText('drawn')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('fails again, with the fallback, when the retry crashes too', () => {
    const { rerender } = render(<DocumentViewerBoundary resetKey="a" fallback={fallback}><Viewer crashes /></DocumentViewerBoundary>)

    rerender(<DocumentViewerBoundary resetKey="b" fallback={fallback}><Viewer crashes /></DocumentViewerBoundary>)

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(reportReactError).toHaveBeenCalledTimes(2)
  })
})
