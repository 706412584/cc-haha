import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import type { Capability } from '../../lib/skillInsights'
import { CapabilityPanel } from './CapabilityPanel'

const CAPABILITIES: Capability[] = [
  { kind: 'shell', level: 'high', evidence: ['scripts/extract-skill.sh', 'mkdir', 'printf'] },
  { kind: 'hooks', level: 'high', evidence: ['hooks/', '~/.openclaw/hooks'] },
  { kind: 'binaries', level: 'low', evidence: ['git'] },
]

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('CapabilityPanel', () => {
  it('names each capability with its evidence and risk level', () => {
    render(<CapabilityPanel capabilities={CAPABILITIES} />)

    expect(screen.getByRole('heading', { name: 'Before installing: what this skill does' })).toBeInTheDocument()
    const shell = screen.getByTestId('market-capability-shell')
    expect(within(shell).getByText('Runs commands or scripts')).toBeInTheDocument()
    // Commands join with a slash, everything else with the list separator.
    expect(shell).toHaveTextContent('scripts/extract-skill.sh / mkdir / printf')
    expect(shell).toHaveTextContent('High')
    expect(screen.getByTestId('market-capability-hooks')).toHaveTextContent('Touches hooks/、~/.openclaw/hooks')
    expect(screen.getByTestId('market-capability-binaries')).toHaveTextContent('Low')
  })

  it('links to the full report only when asked to', () => {
    const onViewReport = vi.fn()
    const { rerender } = render(<CapabilityPanel capabilities={CAPABILITIES} onViewReport={onViewReport} />)

    fireEvent.click(screen.getByRole('button', { name: 'Full report →' }))
    expect(onViewReport).toHaveBeenCalledTimes(1)

    rerender(<CapabilityPanel capabilities={CAPABILITIES} />)
    expect(screen.queryByRole('button', { name: 'Full report →' })).not.toBeInTheDocument()
  })

  it('renders nothing when no rule fired', () => {
    render(<CapabilityPanel capabilities={[]} />)

    expect(screen.queryByTestId('market-capability-panel')).not.toBeInTheDocument()
  })
})
