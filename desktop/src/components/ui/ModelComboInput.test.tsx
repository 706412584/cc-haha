import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelComboInput } from './ModelComboInput'

const options = [
  { id: 'model-a' },
  { id: 'model-b', contextWindow: 128_000 },
]

function renderInput(onChange = vi.fn()) {
  render(<ModelComboInput label="Model" value="" onChange={onChange} options={options} />)
  return { input: screen.getByRole('combobox', { name: 'Model' }), onChange }
}

describe('ModelComboInput', () => {
  it('exposes combobox state and renders its listbox outside clipping ancestors', () => {
    const { input } = renderInput()
    expect(input).toHaveAttribute('aria-expanded', 'false')

    fireEvent.focus(input)

    const listbox = screen.getByRole('listbox')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', listbox.id)
    expect(listbox.parentElement).toBe(document.body)
  })

  it('navigates options with arrows, selects with Enter, and restores focus', () => {
    const { input, onChange } = renderInput()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })

    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'model-a' }).id)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /model-b/ }).id)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('model-b')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveFocus()
  })

  it('opens with ArrowDown and closes with Escape without changing the value', () => {
    const { input, onChange } = renderInput()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
  })
})
