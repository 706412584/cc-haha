import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackgroundTasksBar } from './BackgroundTasksBar'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'chat.backgroundTasks.title': 'Background tasks',
      'chat.backgroundTasks.runningCountOne': '{count} running task',
      'chat.backgroundTasks.finishedCountOne': '{count} finished task',
      'chat.backgroundTasks.watching': 'Watching',
      'chat.backgroundTasks.agentResults': 'Agent Results',
      'chat.backgroundTasks.clear': 'Clear',
      'chat.backgroundTasks.close': 'Close',
      'chat.backgroundTasks.type.agent': 'Agent',
      'chat.backgroundAgents.status.running': 'running',
      'chat.backgroundAgents.status.completed': 'completed',
    }
    let value = translations[key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {})) {
      value = value.replace(`{${name}}`, String(replacement))
    }
    return value
  },
}))

afterEach(cleanup)

describe('BackgroundTasksBar Agent results', () => {
  it('shows watched Agents and their completion result in the existing drawer', () => {
    render(<BackgroundTasksBar tasks={[{
      taskId: 'running-agent',
      taskType: 'local_agent',
      description: 'Review runtime',
      status: 'running',
      startedAt: 1,
      updatedAt: 2,
    }, {
      taskId: 'finished-agent',
      taskType: 'local_agent',
      description: 'Check races',
      status: 'completed',
      result: 'No stale completion was injected.',
      startedAt: 1,
      updatedAt: 3,
    }]} />)

    fireEvent.click(screen.getByTestId('background-tasks-button'))
    expect(screen.getByRole('heading', { name: 'Watching' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Agent Results/ })).toBeInTheDocument()
    expect(screen.getByText('No stale completion was injected.')).toBeInTheDocument()
  })
})
