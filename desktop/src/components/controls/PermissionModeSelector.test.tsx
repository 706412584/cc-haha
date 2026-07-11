import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const viewportMocks = vi.hoisted(() => ({
  isMobile: false,
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => viewportMocks.isMobile,
}))

vi.mock('../../lib/desktopRuntime', () => ({
  isTauriRuntime: () => false,
  isDesktopRuntime: () => false,
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => ({
    'permMode.askPermissions': 'Ask permissions',
    'permMode.askPermDesc': 'Ask before changing files or running commands',
    'permMode.autoAccept': 'Auto accept edits',
    'permMode.autoAcceptDesc': 'Automatically accept edit operations',
    'permMode.planMode': 'Plan mode',
    'permMode.planModeDesc': 'Plan before executing',
    'permMode.bypass': 'Bypass permissions',
    'permMode.bypassDesc': 'Run without permission prompts',
    'permMode.executionPermissions': 'Execution Permissions',
    'permMode.label.default': 'Ask permissions',
    'permMode.label.acceptEdits': 'Auto accept edits',
    'permMode.label.plan': 'Plan mode',
    'permMode.label.bypassPermissions': 'Bypass permissions',
    'permMode.label.dontAsk': 'Bypass permissions',
    'permMode.enableBypassTitle': 'Enable bypass mode',
    'permMode.enableBypassSubtitle': 'This is risky',
    'permMode.enableBypassBody': 'Bypass permissions for this workspace.',
    'permMode.permReadWrite': 'Read and write files',
    'permMode.permShell': 'Run shell commands',
    'permMode.permPackages': 'Install packages',
    'permMode.enableBypassBtn': 'Enable bypass',
    'permMode.disabledDuringTurn': 'Cannot switch permissions while session is active',
    'common.cancel': 'Cancel',
    'tabs.close': 'Close',
  }[key] ?? key),
}))

import { PermissionModeSelector } from './PermissionModeSelector'
import { useChatStore, type PerSessionState } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'

const initialSetSessionPermissionMode = useChatStore.getState().setSessionPermissionMode

function makeChatSession(chatState: PerSessionState['chatState']): PerSessionState {
  return {
    messages: [],
    chatState,
    connectionState: 'connected',
    streamingText: '',
    streamingToolInput: '',
    activeToolUseId: null,
    activeToolName: null,
    activeThinkingId: null,
    pendingPermission: null,
    pendingComputerUsePermission: null,
    tokenUsage: { input_tokens: 0, output_tokens: 0 },
    streamingResponseChars: 0,
    elapsedSeconds: 0,
    statusVerb: '',
    slashCommands: [],
    agentTaskNotifications: {},
    elapsedTimer: null,
  }
}

describe('PermissionModeSelector', () => {
  beforeEach(() => {
    viewportMocks.isMobile = false
    useSettingsStore.setState({ permissionMode: 'default' })
    useChatStore.setState({
      sessions: {},
      setSessionPermissionMode: initialSetSessionPermissionMode,
    })
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    useTabStore.setState({ activeTabId: null, tabs: [] })
  })

  it('updates the active session without writing the global default mode', () => {
    const setGlobalPermissionMode = vi.fn()
    const setSessionPermissionMode = vi.fn()
    useSettingsStore.setState({
      permissionMode: 'default',
      setPermissionMode: setGlobalPermissionMode,
    })
    useChatStore.setState({
      setSessionPermissionMode,
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      activeSessionId: 'current-tab',
      sessions: [
        {
          id: 'current-tab',
          title: 'Current',
          createdAt: '2026-05-24T00:00:00.000Z',
          modifiedAt: '2026-05-24T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/repo',
          projectRoot: '/repo',
          workDir: '/repo',
          workDirExists: true,
          permissionMode: 'default',
        },
      ],
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Auto accept edits/ }))

    expect(setGlobalPermissionMode).not.toHaveBeenCalled()
    expect(setSessionPermissionMode).toHaveBeenCalledWith('current-tab', 'acceptEdits')
  })

  it('labels the compact mobile trigger and opens a phone-sized menu sheet', () => {
    viewportMocks.isMobile = true

    render(<PermissionModeSelector compact workDir="/repo" />)

    const trigger = screen.getByRole('button', { name: 'Ask permissions' })
    expect(trigger).toHaveClass('h-11', 'w-11')
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', 'permission-mode-menu')
    expect(screen.getByRole('dialog', { name: 'Execution Permissions' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Auto accept edits/ })).toBeInTheDocument()
  })

  it('uses the active tab workspace when showing the bypass confirmation path', () => {
    useSessionStore.setState({
      activeSessionId: 'previous-session',
      sessions: [
        {
          id: 'previous-session',
          title: 'Previous',
          createdAt: '2026-05-24T00:00:00.000Z',
          modifiedAt: '2026-05-24T00:00:00.000Z',
          messageCount: 1,
          projectPath: 'C:\\Users\\LinTan',
          projectRoot: 'C:\\Users\\LinTan',
          workDir: 'C:\\Users\\LinTan',
          workDirExists: true,
        },
        {
          id: 'current-tab',
          title: 'Current',
          createdAt: '2026-05-24T00:00:00.000Z',
          modifiedAt: '2026-05-24T00:00:00.000Z',
          messageCount: 1,
          projectPath: 'C:\\Users\\LinTan\\MyScript\\test5',
          projectRoot: 'C:\\Users\\LinTan\\MyScript\\test5',
          workDir: 'C:\\Users\\LinTan\\MyScript\\test5',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector compact />)

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Bypass permissions/ }))

    expect(screen.getByRole('dialog', { name: 'Enable bypass mode' })).toBeInTheDocument()
    expect(screen.getByText('C:\\Users\\LinTan\\MyScript\\test5')).toBeInTheDocument()
    expect(screen.queryByText('C:\\Users\\LinTan')).not.toBeInTheDocument()
  })

  it('disables the trigger button when the session turn is active', () => {
    const setSessionPermissionMode = vi.fn()
    useChatStore.setState({
      setSessionPermissionMode,
      sessions: {
        'current-tab': makeChatSession('thinking'),
      },
    })
    useSessionStore.setState({
      activeSessionId: 'current-tab',
      sessions: [
        {
          id: 'current-tab',
          title: 'Current',
          createdAt: '2026-05-24T00:00:00.000Z',
          modifiedAt: '2026-05-24T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/repo',
          projectRoot: '/repo',
          workDir: '/repo',
          workDirExists: true,
          permissionMode: 'default',
        },
      ],
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)

    const trigger = screen.getByRole('button', { name: 'Ask permissions' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute('title', 'Cannot switch permissions while session is active')

    fireEvent.click(trigger)
    // Menu should not open when disabled
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(setSessionPermissionMode).not.toHaveBeenCalled()
  })

  it('closes an open permission menu when the session turn starts', () => {
    useChatStore.setState({
      sessions: {
        'current-tab': makeChatSession('idle'),
      },
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)

    const trigger = screen.getByRole('button', { name: 'Ask permissions' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: /Auto accept edits/ })).toBeInTheDocument()

    act(() => {
      useChatStore.setState({
        sessions: {
          'current-tab': makeChatSession('thinking'),
        },
      })
    })

    expect(trigger).toBeDisabled()
    expect(screen.queryByRole('menuitem', { name: /Auto accept edits/ })).not.toBeInTheDocument()
  })

  it('closes an open bypass confirmation when the session turn starts', () => {
    useChatStore.setState({
      sessions: {
        'current-tab': makeChatSession('idle'),
      },
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Bypass permissions/ }))
    expect(screen.getByRole('dialog', { name: 'Enable bypass mode' })).toBeInTheDocument()

    act(() => {
      useChatStore.setState({
        sessions: {
          'current-tab': makeChatSession('tool_executing'),
        },
      })
    })

    expect(screen.queryByRole('dialog', { name: 'Enable bypass mode' })).not.toBeInTheDocument()
  })

  it('rejects a stale menu action when the turn starts before click dispatch', () => {
    const setSessionPermissionMode = vi.fn()
    useChatStore.setState({
      setSessionPermissionMode,
      sessions: {
        'current-tab': makeChatSession('idle'),
      },
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    const menuItem = screen.getByRole('menuitem', { name: /Auto accept edits/ })

    act(() => {
      useChatStore.setState({
        sessions: {
          'current-tab': makeChatSession('thinking'),
        },
      })
      menuItem.click()
    })

    expect(setSessionPermissionMode).not.toHaveBeenCalled()
  })

  it('rejects a stale bypass confirmation when the turn starts before click dispatch', () => {
    const setSessionPermissionMode = vi.fn()
    useChatStore.setState({
      setSessionPermissionMode,
      sessions: {
        'current-tab': makeChatSession('idle'),
      },
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Bypass permissions/ }))
    const confirmButton = screen.getByRole('button', { name: 'Enable bypass' })

    act(() => {
      useChatStore.setState({
        sessions: {
          'current-tab': makeChatSession('tool_executing'),
        },
      })
      confirmButton.click()
    })

    expect(setSessionPermissionMode).not.toHaveBeenCalled()
  })

  it('rejects a stale menu action after the active tab changes', () => {
    const setSessionPermissionMode = vi.fn()
    useChatStore.setState({
      setSessionPermissionMode,
      sessions: {
        'current-tab': makeChatSession('idle'),
        'next-tab': makeChatSession('idle'),
      },
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    const menuItem = screen.getByRole('menuitem', { name: /Auto accept edits/ })

    act(() => {
      useTabStore.setState({
        activeTabId: 'next-tab',
        tabs: [{ sessionId: 'next-tab', title: 'Next', type: 'session', status: 'idle' }],
      })
      menuItem.click()
    })

    expect(setSessionPermissionMode).not.toHaveBeenCalled()
  })

  it('rejects a stale bypass confirmation after the active tab changes', () => {
    const setSessionPermissionMode = vi.fn()
    useChatStore.setState({
      setSessionPermissionMode,
      sessions: {
        'current-tab': makeChatSession('idle'),
        'next-tab': makeChatSession('idle'),
      },
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Bypass permissions/ }))
    const confirmButton = screen.getByRole('button', { name: 'Enable bypass' })

    act(() => {
      useTabStore.setState({
        activeTabId: 'next-tab',
        tabs: [{ sessionId: 'next-tab', title: 'Next', type: 'session', status: 'idle' }],
      })
      confirmButton.click()
    })

    expect(setSessionPermissionMode).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Enable bypass mode' })).not.toBeInTheDocument()
  })

  it('reports controlled permission changes through onChange', () => {
    const onChange = vi.fn()

    render(<PermissionModeSelector value="default" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Auto accept edits/ }))

    expect(onChange).toHaveBeenCalledWith('acceptEdits')
  })

  it('closes the permission menu when its trigger is clicked again', () => {
    render(<PermissionModeSelector />)

    const trigger = screen.getByRole('button', { name: 'Ask permissions' })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes the permission menu when the active tab changes', () => {
    useChatStore.setState({
      sessions: {
        'current-tab': makeChatSession('idle'),
        'next-tab': makeChatSession('idle'),
      },
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))

    act(() => {
      useTabStore.setState({
        activeTabId: 'next-tab',
        tabs: [{ sessionId: 'next-tab', title: 'Next', type: 'session', status: 'idle' }],
      })
    })

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes bypass confirmation through both dialog close actions', () => {
    render(<PermissionModeSelector />)

    const openDialog = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
      fireEvent.click(screen.getByRole('menuitem', { name: /Bypass permissions/ }))
    }

    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(screen.queryByRole('dialog', { name: 'Enable bypass mode' })).not.toBeInTheDocument()

    openDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Enable bypass mode' })).not.toBeInTheDocument()
  })
})
