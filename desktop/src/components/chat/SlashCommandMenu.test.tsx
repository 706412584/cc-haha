import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { translate } from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'
import { SlashCommandMenu, getSlashCommandOptionId } from './SlashCommandMenu'

describe('SlashCommandMenu', () => {
  it('renders ordered command groups with stable option ids and accurate skill sources', () => {
    const onSelect = vi.fn()
    const itemRefs = { current: [] as (HTMLElement | null)[] }

    render(
      <SlashCommandMenu
        ref={createRef<HTMLDivElement>()}
        id="slash-menu"
        groups={{
          system: [{ name: 'status', description: 'Show status', kind: 'command' }],
          skills: [
            {
              name: 'project-audit',
              description: 'Audit project UX',
              kind: 'skill',
              source: 'project',
            },
          ],
          ordered: [],
        }}
        selectedIndex={1}
        itemRefs={itemRefs}
        onSelect={onSelect}
        onHighlight={vi.fn()}
        showKeyboardHints
      />,
    )

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('id', getSlashCommandOptionId('slash-menu', 0))
    expect(options[1]).toHaveAttribute('id', getSlashCommandOptionId('slash-menu', 1))
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveTextContent(
      translate(useSettingsStore.getState().locale, 'chat.slashSkillProject'),
    )
    expect(itemRefs.current[1]).toBe(options[1])

    fireEvent.click(options[1]!)
    expect(onSelect).toHaveBeenCalledWith('project-audit')
  })
})
