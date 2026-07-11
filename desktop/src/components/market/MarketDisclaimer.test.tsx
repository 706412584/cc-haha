import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

import { MarketDisclaimer } from './MarketDisclaimer'
import { useSettingsStore } from '../../stores/settingsStore'

const STORAGE_KEY = 'cc-haha-market-disclaimer-dismissed'

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
})

describe('MarketDisclaimer', () => {
  it('renders the disclaimer with the AI-scan advice', () => {
    render(<MarketDisclaimer />)

    expect(screen.getByTestId('market-disclaimer')).toBeInTheDocument()
    expect(screen.getByText('Use third-party skills with care.')).toBeInTheDocument()
    expect(screen.getByText(/have AI scan them for safety first/)).toBeInTheDocument()
  })

  it('dismisses on click and persists the dismissal', () => {
    render(<MarketDisclaimer />)

    fireEvent.click(screen.getByLabelText('Dismiss disclaimer'))

    expect(screen.queryByTestId('market-disclaimer')).not.toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1')
  })

  it('stays hidden when previously dismissed', () => {
    localStorage.setItem(STORAGE_KEY, '1')

    render(<MarketDisclaimer />)

    expect(screen.queryByTestId('market-disclaimer')).not.toBeInTheDocument()
  })
})
