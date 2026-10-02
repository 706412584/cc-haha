import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import { ChangelogPanel } from './ChangelogPanel'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('ChangelogPanel', () => {
  it('shows the release version, date and note as written', () => {
    render(
      <ChangelogPanel
        changelog={{ version: '4.0.2', text: 'Hook is now opt-in.\nFixed paths.', publishedAt: Date.UTC(2026, 7, 6) }}
        pageUrl="https://clawhub.ai/x"
      />,
    )

    const panel = screen.getByTestId('market-changelog-panel')
    expect(panel).toHaveTextContent('v4.0.2')
    expect(panel).toHaveTextContent('2026-08-06')
    expect(screen.getByText(/Hook is now opt-in\./)).toHaveClass('whitespace-pre-wrap')
    expect(screen.getByRole('link', { name: /Source page/ })).toHaveAttribute('href', 'https://clawhub.ai/x')
  })

  it('falls back to the skill version and does not double the v prefix', () => {
    const { unmount } = render(<ChangelogPanel changelog={{ text: 'Notes' }} version="1.2.0" />)
    expect(screen.getByTestId('market-changelog-panel')).toHaveTextContent('v1.2.0')
    unmount()

    render(<ChangelogPanel changelog={{ version: 'v2.0.0', text: 'Notes' }} />)
    expect(screen.getByTestId('market-changelog-panel')).toHaveTextContent('v2.0.0')
    expect(screen.getByTestId('market-changelog-panel')).not.toHaveTextContent('vv2.0.0')
  })

  it('says there is no note, and drops a link that is not http(s)', () => {
    render(<ChangelogPanel pageUrl="file:///etc/passwd" />)

    expect(screen.getByText('Upstream has no release note for this version.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
