import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { Switch } from './Switch'

describe('Switch', () => {
  it('exposes itself as a switch with the label as its name', () => {
    render(<Switch checked={false} onChange={() => {}} label="Auto update" />)
    expect(screen.getByRole('switch', { name: 'Auto update' })).toBeInTheDocument()
  })

  it('reports its checked state', () => {
    const { rerender } = render(<Switch checked={false} onChange={() => {}} label="Auto update" />)
    expect(screen.getByRole('switch')).not.toBeChecked()

    rerender(<Switch checked onChange={() => {}} label="Auto update" />)
    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('reports the new value on toggle', () => {
    const onChange = vi.fn()
    render(<Switch checked={false} onChange={onChange} label="Auto update" />)

    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('keeps an accessible name when the visible label is hidden', () => {
    render(<Switch checked onChange={() => {}} label="Enable server" labelHidden />)
    expect(screen.getByRole('switch', { name: 'Enable server' })).toBeInTheDocument()
    expect(screen.queryByText('Enable server')).not.toBeInTheDocument()
  })

  it('links its description for screen readers', () => {
    render(
      <Switch checked onChange={() => {}} label="Auto update" description="Checks on launch." />,
    )
    const input = screen.getByRole('switch')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent('Checks on launch.')
  })

  it('disables the input itself rather than only dimming it', () => {
    // Asserted on the attribute, not by simulating a click: jsdom fires change
    // on a disabled input (it does so even for a bare `<input disabled>`), so a
    // click-based assertion here would be testing jsdom, not the component.
    // The attribute is what makes real browsers refuse the interaction.
    render(<Switch checked={false} onChange={() => {}} label="Auto update" disabled />)
    expect(screen.getByRole('switch')).toBeDisabled()
  })

  it('keeps both sizes proportional', () => {
    // The two hand-rolled toggles differed by 27% (56x32 vs 44x24).
    const { container: small } = render(<Switch checked onChange={() => {}} label="A" size="sm" />)
    const { container: medium } = render(<Switch checked onChange={() => {}} label="B" size="md" />)

    expect(small.querySelector('.h-5.w-9')).toBeInTheDocument()
    expect(medium.querySelector('.h-6.w-11')).toBeInTheDocument()
  })
})
