import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

import { InstallConfirmDialog } from './InstallConfirmDialog'
import { useSettingsStore } from '../../stores/settingsStore'
import type { NormalizedSkill } from '../../types/market'

function makeSkill(overrides: Partial<NormalizedSkill> = {}): NormalizedSkill {
  return {
    id: 'skillhub:demo',
    source: 'skillhub',
    slug: 'demo',
    name: '示例技能',
    summary: 'demo',
    author: { handle: 'alice' },
    stats: { downloads: 1 },
    tags: [],
    version: '2.0.0',
    securityStatus: 'benign',
    installState: 'installable',
    ...overrides,
  }
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('InstallConfirmDialog', () => {
  it('shows name, source, version, security and install location', () => {
    render(
      <InstallConfirmDialog skill={makeSkill()} open installing={false} onConfirm={vi.fn()} onClose={vi.fn()} />,
    )

    expect(screen.getByTestId('market-install-confirm')).toHaveTextContent('示例技能')
    expect(screen.getAllByText('SkillHub').length).toBeGreaterThan(0)
    expect(screen.getByText('v2.0.0')).toBeInTheDocument()
    expect(screen.getByTestId('security-badge-benign')).toBeInTheDocument()
    expect(screen.getByText('~/.claude/skills/demo/')).toBeInTheDocument()
    expect(screen.getByText(/new sessions/)).toBeInTheDocument()
  })

  it('warns strongly for flagged skills', () => {
    render(
      <InstallConfirmDialog
        skill={makeSkill({ securityStatus: 'flagged' })}
        open
        installing={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(/flagged this skill as potentially risky/)).toBeInTheDocument()
  })

  it('warns for unaudited skills', () => {
    render(
      <InstallConfirmDialog
        skill={makeSkill({ securityStatus: 'unknown' })}
        open
        installing={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText(/has not been security-audited/)).toBeInTheDocument()
  })

  it('confirms and cancels', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<InstallConfirmDialog skill={makeSkill()} open installing={false} onConfirm={onConfirm} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('market-install-confirm-button'))
    expect(onConfirm).toHaveBeenCalled()

    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('disables both buttons while installing', () => {
    render(<InstallConfirmDialog skill={makeSkill()} open installing onConfirm={vi.fn()} onClose={vi.fn()} />)

    expect(screen.getByTestId('market-install-confirm-button')).toBeDisabled()
    expect(screen.getByText('Cancel').closest('button')).toBeDisabled()
  })
})
