import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { useSettingsStore } from '../../stores/settingsStore'
import type { Capability } from '../../lib/skillInsights'
import { SecurityReportPanel } from './SecurityReportPanel'

const SHELL: Capability = { kind: 'shell', level: 'high', evidence: ['scripts/run.sh'] }

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('SecurityReportPanel', () => {
  it('lists each scanner with its verdict, explanation and report link', () => {
    render(
      <SecurityReportPanel
        capabilities={[]}
        reports={[
          { vendor: 'VirusTotal', status: 'clean', statusText: 'clean', reportUrl: 'https://www.virustotal.com/r' },
          { vendor: 'LLM review', status: 'suspicious', statusText: 'suspicious', summary: 'Reads transcripts.' },
        ]}
      />,
    )

    const reports = screen.getAllByTestId('market-security-report')
    expect(reports).toHaveLength(2)
    expect(within(reports[0]!).getByRole('link', { name: /View report/ })).toHaveAttribute(
      'href',
      'https://www.virustotal.com/r',
    )
    expect(within(reports[1]!).getByText('Reads transcripts.')).toBeInTheDocument()
    expect(within(reports[1]!).queryByRole('link')).not.toBeInTheDocument()
  })

  it('never turns a non-http report URL into a link', () => {
    render(
      <SecurityReportPanel
        capabilities={[]}
        reports={[{ vendor: 'scan', status: 'suspicious', statusText: 'x', reportUrl: 'javascript:alert(1)' }]}
      />,
    )

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('says so when upstream has no scan, and always carries the disclaimer', () => {
    render(<SecurityReportPanel capabilities={[]} reports={[]} />)

    expect(screen.getByText('Upstream has no security scan for this skill.')).toBeInTheDocument()
    expect(screen.getByText(/does not vouch for them/)).toBeInTheDocument()
  })

  it('shows the capability list and the curator note when there are any', () => {
    render(<SecurityReportPanel capabilities={[SHELL]} reports={[]} securityNote="Hook is opt-in." />)

    expect(screen.getByTestId('market-capability-shell')).toHaveTextContent('scripts/run.sh')
    // Already inside the report: no "full report" link pointing at itself.
    expect(screen.queryByTestId('market-capability-view-report')).not.toBeInTheDocument()
    expect(screen.getByTestId('market-security-note')).toHaveTextContent('Curator note')
    expect(screen.getByTestId('market-security-note')).toHaveTextContent('Hook is opt-in.')
  })
})
