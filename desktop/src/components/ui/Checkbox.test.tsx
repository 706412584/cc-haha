import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { Checkbox } from './Checkbox'

describe('Checkbox', () => {
  it('associates the label with the input', () => {
    render(<Checkbox label="Include archived" />)
    expect(screen.getByRole('checkbox', { name: 'Include archived' })).toBeInTheDocument()
  })

  it('toggles on label click', () => {
    const onChange = vi.fn()
    render(<Checkbox label="Include archived" onChange={onChange} />)

    fireEvent.click(screen.getByText('Include archived'))
    expect(onChange).toHaveBeenCalled()
  })

  it('keeps an accessible name when the visible label is hidden', () => {
    render(<Checkbox label="Select row" labelHidden />)
    expect(screen.getByRole('checkbox', { name: 'Select row' })).toBeInTheDocument()
    expect(screen.queryByText('Select row')).not.toBeInTheDocument()
  })

  it('sets indeterminate on the DOM node, which no attribute can express', () => {
    const { rerender } = render(<Checkbox label="All" indeterminate />)
    const input = screen.getByRole('checkbox') as HTMLInputElement
    expect(input.indeterminate).toBe(true)

    rerender(<Checkbox label="All" indeterminate={false} />)
    expect(input.indeterminate).toBe(false)
  })

  it('links its description for screen readers', () => {
    render(<Checkbox label="Trust plugin" description="Runs with full file access." />)
    const describedBy = screen.getByRole('checkbox').getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)).toHaveTextContent('Runs with full file access.')
  })

  it('disables the input itself rather than only dimming it', () => {
    // See the note in Switch.test.tsx: jsdom fires change on disabled inputs,
    // so the attribute is the only meaningful assertion here.
    render(<Checkbox label="Include archived" disabled />)
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })

  it('uses one accent token rather than the two aliases in circulation', () => {
    render(<Checkbox label="Include archived" />)
    expect(screen.getByRole('checkbox').className).toContain('accent-[var(--color-brand)]')
  })

  it('has a visible focus ring', () => {
    render(<Checkbox label="Include archived" />)
    expect(screen.getByRole('checkbox').className).toContain('focus-visible:ring-2')
  })
})
