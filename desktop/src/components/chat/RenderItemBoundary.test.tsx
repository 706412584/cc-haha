import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const { reportMock } = vi.hoisted(() => ({
  reportMock: vi.fn(async () => undefined),
}))

vi.mock('../../lib/diagnosticsCapture', () => ({
  reportReactError: reportMock,
}))

import { RenderItemBoundary } from './RenderItemBoundary'
import { useSettingsStore } from '../../stores/settingsStore'

function Explodes(): never {
  throw new Error('row exploded')
}

describe('RenderItemBoundary', () => {
  beforeEach(() => {
    reportMock.mockClear()
    useSettingsStore.setState({ locale: 'en' })
    // React logs every caught render error; keep the output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders its children untouched when nothing throws', () => {
    render(<RenderItemBoundary><span>fine</span></RenderItemBoundary>)

    expect(screen.getByText('fine')).toBeTruthy()
    expect(screen.queryByText(/couldn't be displayed/)).toBeNull()
    expect(reportMock).not.toHaveBeenCalled()
  })

  // The point of the boundary: the failure stays where it happened.
  it('replaces only the item that throws and leaves its neighbours alone', () => {
    render(
      <div>
        <RenderItemBoundary><span>before</span></RenderItemBoundary>
        <RenderItemBoundary><Explodes /></RenderItemBoundary>
        <RenderItemBoundary><span>after</span></RenderItemBoundary>
      </div>,
    )

    expect(screen.getByText('before')).toBeTruthy()
    expect(screen.getByText('after')).toBeTruthy()
    expect(screen.getByText(/couldn't be displayed/)).toBeTruthy()
  })

  it('still records the error in Diagnostics, with the component stack', () => {
    render(<RenderItemBoundary><Explodes /></RenderItemBoundary>)

    expect(reportMock).toHaveBeenCalledTimes(1)
    const [error, info] = reportMock.mock.calls[0] as unknown as [Error, { componentStack: string }]
    expect(error.message).toBe('row exploded')
    expect(info.componentStack).toContain('Explodes')
  })

  it('does not report a failed item again when its parent re-renders', () => {
    const { rerender } = render(<RenderItemBoundary><Explodes /></RenderItemBoundary>)
    expect(reportMock).toHaveBeenCalledTimes(1)

    rerender(<RenderItemBoundary><Explodes /></RenderItemBoundary>)
    rerender(<RenderItemBoundary><Explodes /></RenderItemBoundary>)

    expect(reportMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/couldn't be displayed/)).toBeTruthy()
  })
})
