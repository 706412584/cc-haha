import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openLocalFileWithSystem, reportOpenFailure } from '@/lib/systemFileOpen'
import { useSettingsStore } from '@/stores/settingsStore'
import { OpenInSystemButton } from './OpenInSystemButton'

vi.mock('@/lib/systemFileOpen', () => ({
  openLocalFileWithSystem: vi.fn(),
  reportOpenFailure: vi.fn(),
}))

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  vi.mocked(openLocalFileWithSystem).mockReset().mockResolvedValue(undefined)
  vi.mocked(reportOpenFailure).mockReset()
})

describe('OpenInSystemButton', () => {
  it('is named for what it does, in the reader’s language', () => {
    render(<OpenInSystemButton absolutePath="/work/out/thesis.pdf" />)

    expect(screen.getByRole('button', { name: 'Open in system app' })).toBeInTheDocument()
  })

  it('hands the file to the operating system', () => {
    render(<OpenInSystemButton absolutePath="/work/out/thesis.pdf" />)

    fireEvent.click(screen.getByRole('button'))

    expect(openLocalFileWithSystem).toHaveBeenCalledWith('/work/out/thesis.pdf')
  })

  it('says nothing when the file opened', async () => {
    render(<OpenInSystemButton absolutePath="/work/out/thesis.pdf" />)

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(openLocalFileWithSystem).toHaveBeenCalled())

    expect(reportOpenFailure).not.toHaveBeenCalled()
  })

  it('names the file it could not open: a click that does nothing reads as a broken button', async () => {
    vi.mocked(openLocalFileWithSystem).mockRejectedValue(new Error('no application'))
    render(<OpenInSystemButton absolutePath="/work/out/thesis.pdf" />)

    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => expect(reportOpenFailure).toHaveBeenCalledWith('/work/out/thesis.pdf'))
  })
})
