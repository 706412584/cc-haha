import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./SkillDetailView', () => ({
  SkillDetailView: ({ meta, actions, banner, onBack, backLabel }: {
    meta: Array<{ label: string; value: string }>
    actions?: React.ReactNode
    banner?: React.ReactNode
    onBack: () => void
    backLabel: string
  }) => (
    <div data-testid="detail-view">
      {meta.map((item) => <span key={item.label}>{`${item.label}=${item.value}`}</span>)}
      {actions}
      {banner}
      <button type="button" data-testid="detail-back" onClick={onBack}>{backLabel}</button>
    </div>
  ),
}))

import { useMarketStore } from '../../stores/marketStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { MarketSkillDetail } from './MarketSkillDetail'

const backToList = vi.fn()
const refreshDetail = vi.fn()

function setStore(partial: Record<string, unknown>) {
  useMarketStore.setState({
    selectedId: 'skill-1',
    detail: null,
    isDetailLoading: false,
    detailError: null,
    installingIds: new Set<string>(),
    installError: null,
    backToList,
    refreshDetail,
    fetchFileContent: vi.fn(),
    ...partial,
  } as never)
}

function makeDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'skill-1',
    name: 'Weather',
    author: { displayName: 'Ada', handle: 'ada' },
    stats: { downloads: 12_500 },
    files: [],
    source: 'clawhub',
    installState: 'installable',
    ...overrides,
  }
}

describe('MarketSkillDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
  })

  it('shows a labeled skeleton group while loading', () => {
    // The placeholder used to be a bare `animate-pulse` div, invisible to a
    // screen reader; SkeletonGroup carries role=status and aria-busy.
    setStore({ isDetailLoading: true })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status.className).toContain('animate-pulse')
  })

  it('offers a retry when the detail fails to load', () => {
    setStore({ detailError: 'network down' })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    expect(screen.getByText(/network down/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(refreshDetail).toHaveBeenCalledWith('skill-1')
  })

  it('formats large download counts compactly', () => {
    setStore({ detail: makeDetail() })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)
    expect(screen.getByTestId('detail-view')).toHaveTextContent('12.5k')
  })

  it('requests install for the selected skill', () => {
    const onRequestInstall = vi.fn()
    setStore({ detail: makeDetail() })
    render(<MarketSkillDetail onRequestInstall={onRequestInstall} onRequestUninstall={vi.fn()} />)

    fireEvent.click(screen.getByTestId('market-install-button'))
    expect(onRequestInstall).toHaveBeenCalledWith('skill-1')
  })

  it('offers uninstall instead once installed', () => {
    const onRequestUninstall = vi.fn()
    setStore({ detail: makeDetail({ installState: 'installed' }) })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={onRequestUninstall} />)

    expect(screen.queryByTestId('market-install-button')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('market-uninstall-button'))
    expect(onRequestUninstall).toHaveBeenCalledWith('skill-1')
  })

  it('disables the action and shows a spinner while installing', () => {
    setStore({ detail: makeDetail(), installingIds: new Set(['skill-1']) })
    const { container } = render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    expect(screen.getByTestId('market-install-button')).toBeDisabled()
    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument()
  })

  it('goes back to the list', () => {
    setStore({ detail: makeDetail() })
    render(<MarketSkillDetail onRequestInstall={vi.fn()} onRequestUninstall={vi.fn()} />)

    fireEvent.click(screen.getByTestId('detail-back'))
    expect(backToList).toHaveBeenCalled()
  })
})
