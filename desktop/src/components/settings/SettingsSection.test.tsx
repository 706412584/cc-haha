import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import {
  SettingsPageHeader,
  SettingsPill,
  SettingsSection,
  SettingsStat,
} from './SettingsSection'

describe('SettingsPageHeader', () => {
  it('renders the title as a heading so panes are navigable by landmark', () => {
    render(<SettingsPageHeader title="Providers" description="Pick a default" />)
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeInTheDocument()
    expect(screen.getByText('Pick a default')).toBeInTheDocument()
  })

  it('sets the serif family on the title', () => {
    render(<SettingsPageHeader title="Providers" />)
    expect(screen.getByRole('heading', { name: 'Providers' })).toHaveStyle({
      fontFamily: 'var(--font-headline)',
    })
  })

  it('omits the description line when none is given', () => {
    const { container } = render(<SettingsPageHeader title="Providers" />)
    expect(container.querySelector('p')).toBeNull()
  })

  it('renders the action slot', () => {
    render(<SettingsPageHeader title="Providers" action={<button type="button">Add</button>} />)
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})

describe('SettingsSection', () => {
  it('labels its children with a heading', () => {
    render(
      <SettingsSection title="Appearance" description="Theme and density">
        <span>body</span>
      </SettingsSection>,
    )
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('renders as a section element so the heading scopes a region', () => {
    const { container } = render(<SettingsSection title="Appearance">x</SettingsSection>)
    expect(container.firstElementChild?.tagName).toBe('SECTION')
  })
})

describe('SettingsPill', () => {
  it('reports its selection through aria-pressed', () => {
    render(
      <>
        <SettingsPill selected onClick={() => {}}>Paper</SettingsPill>
        <SettingsPill selected={false} onClick={() => {}}>Dark</SettingsPill>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('defaults to type="button" so it cannot submit a surrounding form', () => {
    render(<SettingsPill selected={false} onClick={() => {}}>Paper</SettingsPill>)
    expect(screen.getByRole('button', { name: 'Paper' })).toHaveAttribute('type', 'button')
  })

  it('fills with ink when selected and tone is ink', () => {
    render(<SettingsPill selected onClick={() => {}}>Paper</SettingsPill>)
    expect(screen.getByRole('button', { name: 'Paper' }).className)
      .toContain('bg-[var(--color-btn-primary-bg)]')
  })

  it('outlines in terracotta when selected and tone is terracotta', () => {
    render(<SettingsPill selected tone="terracotta" onClick={() => {}}>DeepSeek</SettingsPill>)
    const className = screen.getByRole('button', { name: 'DeepSeek' }).className
    expect(className).toContain('border-[var(--color-primary-fixed-dim)]')
    // The soft fill's own accent is too low-contrast on it under the two ink
    // palettes; the paired token is the readable one.
    expect(className).toContain('text-[var(--color-on-brand-soft)]')
  })

  it('calls onClick', () => {
    const onClick = vi.fn()
    render(<SettingsPill selected={false} onClick={onClick}>Paper</SettingsPill>)
    fireEvent.click(screen.getByRole('button', { name: 'Paper' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('can be disabled', () => {
    render(<SettingsPill selected={false} disabled onClick={() => {}}>Paper</SettingsPill>)
    expect(screen.getByRole('button', { name: 'Paper' })).toBeDisabled()
  })
})

describe('SettingsStat', () => {
  it('renders the value in the serif face and keeps the label readable', () => {
    render(<SettingsStat label="Sessions" value="128" />)
    expect(screen.getByText('128')).toHaveStyle({ fontFamily: 'var(--font-headline)' })
    expect(screen.getByText('Sessions')).toBeInTheDocument()
  })

  it('renders the optional hint line', () => {
    render(<SettingsStat label="Sessions" value="128" hint="last 30 days" />)
    expect(screen.getByText('last 30 days')).toBeInTheDocument()
  })
})
