import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { DocumentFailure } from './DocumentFailure'

vi.mock('@/lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn().mockResolvedValue(undefined),
  reportOpenFailure: vi.fn(),
}))

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

const buttons = () => screen.getAllByRole('button').map((button) => button.textContent)

describe('DocumentFailure', () => {
  it('announces what went wrong as an alert', () => {
    render(<DocumentFailure message="This document could not be displayed." absolutePath="/work/a.pdf" />)

    expect(screen.getByRole('alert')).toHaveTextContent('This document could not be displayed.')
  })

  it('offers to try again only when trying again can help', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<DocumentFailure message="x" absolutePath="/work/a.pdf" onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)

    rerender(<DocumentFailure message="x" absolutePath="/work/a.pdf" />)
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it.each(['/work/a.pdf', 'C:\\work\\a.pdf', '~/a.pdf'])('offers the system app for the rooted path %s', (absolutePath) => {
    render(<DocumentFailure message="x" absolutePath={absolutePath} />)

    expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
  })

  it.each(['docs/a.pdf', ''])('does not offer the system app for %j, which the OS could not resolve', (absolutePath) => {
    render(<DocumentFailure message="x" absolutePath={absolutePath} />)

    expect(screen.queryByRole('button', { name: 'Open in system app' })).not.toBeInTheDocument()
  })

  it('puts actions specific to the kind of document between retrying and the system app', () => {
    render(
      <DocumentFailure
        message="x"
        absolutePath="/work/a.pdf"
        onRetry={() => undefined}
        extraActions={<button type="button">Open in browser</button>}
      />,
    )

    expect(buttons()).toEqual(['Try again', 'Open in browser', 'Open in system app'])
  })

  it('shows an action that only the document kind knows of, even when nothing else can be offered', () => {
    render(<DocumentFailure message="x" absolutePath="docs/a.pdf" extraActions={<button type="button">Open in browser</button>} />)

    expect(buttons()).toEqual(['Open in browser'])
  })

  it('shows the message alone when there is nothing to offer', () => {
    render(<DocumentFailure message="This file is outside the workspace." absolutePath="docs/a.pdf" />)

    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })
})
