import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { SelectField } from './SelectField'

const OPTIONS = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE', disabled: true },
] as const

describe('SelectField', () => {
  it('always has an accessible name', () => {
    // All 7 native selects in the app shipped without one.
    render(<SelectField label="Transport" options={OPTIONS} value="stdio" onChange={() => {}} />)
    expect(screen.getByRole('combobox', { name: 'Transport' })).toBeInTheDocument()
  })

  it('keeps the name when the visible label is hidden', () => {
    render(<SelectField label="Transport" labelHidden options={OPTIONS} value="stdio" onChange={() => {}} />)
    expect(screen.getByRole('combobox', { name: 'Transport' })).toBeInTheDocument()
    expect(screen.queryByText('Transport')).not.toBeInTheDocument()
  })

  it('reports the picked value, not the event', () => {
    const onChange = vi.fn()
    render(<SelectField label="Transport" options={OPTIONS} value="stdio" onChange={onChange} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'http' } })
    expect(onChange).toHaveBeenCalledWith('http')
  })

  it('renders every option and honors per-option disabling', () => {
    render(<SelectField label="Transport" options={OPTIONS} value="stdio" onChange={() => {}} />)
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('option', { name: 'SSE' })).toBeDisabled()
  })

  it('marks itself invalid and announces the error', () => {
    render(<SelectField label="Transport" options={OPTIONS} value="stdio" onChange={() => {}} error="Pick one" />)
    const select = screen.getByRole('combobox')

    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(select.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  })

  it('carries a disabled style', () => {
    render(<SelectField label="Transport" options={OPTIONS} value="stdio" onChange={() => {}} disabled />)
    const select = screen.getByRole('combobox')
    expect(select).toBeDisabled()
    expect(select.className).toContain('disabled:opacity-60')
  })
})
