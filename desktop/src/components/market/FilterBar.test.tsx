import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import { useMarketStore } from '../../stores/marketStore'
import { FilterBar } from './FilterBar'

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.setState({ locale: 'en' })
  useMarketStore.setState({ filters: { source: 'all', security: 'all', installed: 'all' } })
})

describe('FilterBar', () => {
  it('renders one chip per filter', () => {
    render(<FilterBar />)

    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByText('All sources')).toBeInTheDocument()
  })

  // Regression: `Dropdown` clones its trigger to attach the ref, the aria state
  // and its own click handler. `FilterTrigger` used to be a plain function
  // component that neither forwarded the ref nor spread the rest of its props,
  // so every one of those was dropped on the floor — the chips rendered and
  // looked interactive, but no menu ever opened.
  it('opens the source menu when its chip is clicked', () => {
    render(<FilterBar />)

    const chip = screen.getAllByRole('button')[0]!
    expect(chip).toHaveAttribute('aria-haspopup', 'listbox')
    expect(chip).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(chip)

    const listbox = screen.getByRole('listbox')
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(within(listbox).getAllByRole('option')).toHaveLength(3)
  })

  it('writes the chosen option back to the store', () => {
    render(<FilterBar />)

    fireEvent.click(screen.getAllByRole('button')[0]!)
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /ClawHub/i }))

    expect(useMarketStore.getState().filters.source).toBe('clawhub')
  })
})
