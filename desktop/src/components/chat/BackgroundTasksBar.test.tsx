import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '../../stores/settingsStore'
import { createBackgroundTaskDismissKey } from '../../lib/backgroundTasks'
import type { BackgroundAgentTask } from '../../types/chat'
import { BackgroundTasksBar } from './BackgroundTasksBar'

function makeTask(overrides: Partial<BackgroundAgentTask> = {}): BackgroundAgentTask {
  return {
    taskId: 'task-1',
    description: 'Audit the sidebar',
    subagentType: 'reviewer',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  } as BackgroundAgentTask
}

describe('BackgroundTasksBar', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('renders nothing without tasks', () => {
    const { container } = render(<BackgroundTasksBar tasks={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('summarizes running tasks on the trigger', () => {
    render(<BackgroundTasksBar tasks={[makeTask(), makeTask({ taskId: 'task-2' })]} />)
    expect(screen.getByTestId('background-tasks-button')).toHaveTextContent('2')
  })

  it('opens and closes the drawer, reporting expanded state', () => {
    render(<BackgroundTasksBar tasks={[makeTask()]} />)
    const trigger = screen.getByTestId('background-tasks-button')

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('background-tasks-drawer')).not.toBeInTheDocument()

    fireEvent.click(trigger)
    expect(screen.getByTestId('background-tasks-drawer')).toBeInTheDocument()

    // The close control is an IconButton, so it carries a name rather than
    // being an anonymous glyph.
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByTestId('background-tasks-drawer')).not.toBeInTheDocument()
  })

  it('closes the drawer on Escape', () => {
    render(<BackgroundTasksBar tasks={[makeTask()]} />)
    fireEvent.click(screen.getByTestId('background-tasks-button'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('background-tasks-drawer')).not.toBeInTheDocument()
  })

  it('separates running from finished tasks', () => {
    render(
      <BackgroundTasksBar
        tasks={[
          makeTask({ taskId: 'running-1' }),
          makeTask({ taskId: 'done-1', status: 'completed', updatedAt: 3_000 }),
        ]}
      />,
    )
    fireEvent.click(screen.getByTestId('background-tasks-button'))

    const drawer = screen.getByTestId('background-tasks-drawer')
    expect(drawer).toHaveTextContent('Audit the sidebar')
    expect(screen.getByRole('dialog')).toHaveAccessibleName()
  })

  it('hides finished tasks the caller has dismissed', () => {
    const finished = makeTask({ taskId: 'done-1', status: 'completed' })
    const { container } = render(
      <BackgroundTasksBar
        tasks={[finished]}
        dismissedFinishedTaskKeys={new Set([createBackgroundTaskDismissKey(finished)])}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('reports every finished key when clearing, dismissed ones included', () => {
    const onClearFinished = vi.fn()
    const finished = makeTask({ taskId: 'done-1', status: 'completed' })
    render(
      <BackgroundTasksBar
        tasks={[makeTask({ taskId: 'running-1' }), finished]}
        onClearFinished={onClearFinished}
      />,
    )
    fireEvent.click(screen.getByTestId('background-tasks-button'))
    fireEvent.click(screen.getByRole('button', { name: /clear/i }))

    expect(onClearFinished).toHaveBeenCalledWith([createBackgroundTaskDismissKey(finished)])
  })

  it('keeps the drawer open after clearing while work is still running', () => {
    render(
      <BackgroundTasksBar
        tasks={[makeTask({ taskId: 'running-1' }), makeTask({ taskId: 'done-1', status: 'completed' })]}
        onClearFinished={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('background-tasks-button'))
    fireEvent.click(screen.getByRole('button', { name: /clear/i }))

    expect(screen.getByTestId('background-tasks-drawer')).toBeInTheDocument()
  })
})
