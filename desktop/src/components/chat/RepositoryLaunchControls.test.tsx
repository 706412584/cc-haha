import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const viewportMocks = vi.hoisted(() => ({
  isMobile: false,
  isTauri: false,
}))

const apiMocks = vi.hoisted(() => ({
  getRepositoryContext: vi.fn(),
}))

vi.mock('../../hooks/useMobileViewport', () => ({
  useMobileViewport: () => viewportMocks.isMobile,
}))

vi.mock('../../lib/desktopRuntime', () => ({
  isTauriRuntime: () => viewportMocks.isTauri,
  isDesktopRuntime: () => viewportMocks.isTauri,
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getRepositoryContext: apiMocks.getRepositoryContext,
  },
}))

// Must match the component's own import specifier, or the mock silently does
// nothing and the real picker renders. It moved to composite/ in the directory
// reshuffle and this path was left behind.
vi.mock('@/components/composite/DirectoryPicker', () => ({
  DirectoryPicker: ({ value }: { value: string }) => (
    <button type="button" role="menuitem">Project {value}</button>
  ),
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => ({
    'common.loading': 'Loading',
    'dirPicker.selectProject': 'Select a project',
    'repoLaunch.branch': 'Branch',
    'repoLaunch.checkedOut': 'Checked out',
    'repoLaunch.checkedOutWarning': 'Branch is checked out elsewhere',
    'repoLaunch.currentBranch': 'Current branch',
    'repoLaunch.dirtyWarning': 'Dirty worktree',
    'repoLaunch.launchLocation': 'Location',
    'repoLaunch.localBranch': 'Local branch',
    'repoLaunch.missingWorkdir': 'Missing working directory',
    'repoLaunch.noBranch': 'No branch',
    'repoLaunch.noBranchMatch': 'No matching branches',
    'repoLaunch.remoteBranch': 'Remote branch',
    'repoLaunch.searchBranch': 'Search branches',
    'repoLaunch.selectBranch': 'Select branch',
    'repoLaunch.selectWorktree': 'Select worktree mode',
    'repoLaunch.worktreeBadge': 'Isolated',
    'repoLaunch.worktreeCurrent': 'Current worktree',
    'repoLaunch.worktreeCurrentHint': 'Work in this folder',
    'repoLaunch.worktreeIsolated': 'Isolated worktree',
    'repoLaunch.worktreeIsolatedHint': 'New isolated copy',
    'tabs.close': 'Close',
  }[key] ?? key),
}))

import { RepositoryLaunchControls } from './RepositoryLaunchControls'

const okRepositoryContext = {
  state: 'ok' as const,
  workDir: '/repo',
  repoRoot: '/repo',
  repoName: 'cc-haha',
  currentBranch: 'main',
  defaultBranch: 'main',
  dirty: false,
  worktrees: [],
  branches: [
    {
      name: 'main',
      current: true,
      local: true,
      remote: false,
      checkedOut: false,
      remoteRef: null,
      worktreePath: null,
    },
    {
      name: 'feature/h5',
      current: false,
      local: true,
      remote: false,
      checkedOut: false,
      remoteRef: null,
      worktreePath: null,
    },
  ],
}

function renderControls(props: Partial<ComponentProps<typeof RepositoryLaunchControls>> = {}) {
  const defaultProps: ComponentProps<typeof RepositoryLaunchControls> = {
    workDir: '/repo',
    onWorkDirChange: vi.fn(),
    branch: 'main',
    onBranchChange: vi.fn(),
    useWorktree: false,
    onUseWorktreeChange: vi.fn(),
  }

  return render(<RepositoryLaunchControls {...defaultProps} {...props} />)
}

/** Opens the pill's root menu. */
async function openPill() {
  const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
  fireEvent.click(pill)
  return pill
}

/** Opens the pill, then drills into the branch view. */
async function openBranchView() {
  await openPill()
  fireEvent.click(await screen.findByRole('menuitem', { name: /Branch/ }))
  return screen.findByRole('listbox', { name: 'Select branch' })
}

describe('RepositoryLaunchControls', () => {
  beforeEach(() => {
    viewportMocks.isMobile = false
    viewportMocks.isTauri = false
    apiMocks.getRepositoryContext.mockReset()
    apiMocks.getRepositoryContext.mockResolvedValue(okRepositoryContext)
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('collapses directory, branch and worktree into a single pill', async () => {
    renderControls()

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    expect(pill).toHaveAttribute('aria-haspopup', 'menu')
    expect(within(pill).getByText('cc-haha')).toBeInTheDocument()
    expect(within(pill).getByText('main')).toBeInTheDocument()

    // The three separate triggers are gone — that was the point of the change.
    expect(screen.queryByRole('button', { name: /Select branch:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Select worktree mode:/ })).not.toBeInTheDocument()
  })

  it('truncates the branch from the start so its tail survives', async () => {
    renderControls()

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    // `dir="rtl"` is what moves the ellipsis to the front; without it a long
    // `feature/...` name would truncate down to its meaningless prefix.
    expect(within(pill).getByText('main').closest('[dir="rtl"]')).not.toBeNull()
  })

  it('marks the isolated worktree on the pill itself', async () => {
    renderControls({ useWorktree: true })

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    expect(within(pill).getByText('Isolated')).toBeInTheDocument()
  })

  it('offers directory, branch and both worktree modes in the root menu', async () => {
    renderControls()
    await openPill()

    const menu = await screen.findByRole('menu', { name: 'Location' })
    expect(within(menu).getByRole('menuitem', { name: /Project \/repo/ })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /Branch/ })).toBeInTheDocument()

    const current = within(menu).getByRole('menuitemradio', { name: /Current worktree/ })
    const isolated = within(menu).getByRole('menuitemradio', { name: /Isolated worktree/ })
    expect(current).toHaveAttribute('aria-checked', 'true')
    expect(isolated).toHaveAttribute('aria-checked', 'false')
  })

  it('switches worktree mode straight from the root menu', async () => {
    const onUseWorktreeChange = vi.fn()
    renderControls({ onUseWorktreeChange })
    await openPill()

    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Isolated worktree/ }))

    expect(onUseWorktreeChange).toHaveBeenCalledWith(true)
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })
  })

  it('drills into the branch list and back out again', async () => {
    renderControls()
    await openBranchView()

    expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Select branch/ }))

    expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()
    expect(screen.queryByRole('listbox', { name: 'Select branch' })).not.toBeInTheDocument()
  })

  it('returns to the root view after picking a branch', async () => {
    const onBranchChange = vi.fn()
    renderControls({ onBranchChange })
    await openBranchView()

    fireEvent.click(screen.getByRole('option', { name: /feature\/h5/ }))

    expect(onBranchChange).toHaveBeenCalledWith('feature/h5')
    expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()
  })

  it('keeps keyboard branch selection working from the search field', async () => {
    const onBranchChange = vi.fn()
    renderControls({ onBranchChange })
    await openBranchView()

    const input = await screen.findByPlaceholderText('Search branches')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onBranchChange).toHaveBeenCalledWith('feature/h5')
    })
  })

  it('uses the desktop dropdown, not the mobile sheet, on a wide viewport', async () => {
    renderControls()
    await openBranchView()

    expect(screen.getByRole('listbox', { name: 'Select branch' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('uses the full-width mobile bottom sheet in H5 mobile browser mode', async () => {
    viewportMocks.isMobile = true
    viewportMocks.isTauri = false

    renderControls()
    await openPill()

    const dialog = await screen.findByRole('dialog', { name: 'Location' })
    expect(dialog).toHaveClass('inset-x-0')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(within(dialog).getByRole('menu', { name: 'Location' })).toBeInTheDocument()
  })

  it('does not use the H5 mobile sheet inside Tauri even on a narrow viewport', async () => {
    viewportMocks.isMobile = true
    viewportMocks.isTauri = true

    renderControls()
    await openPill()

    expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('sizes the pill for the toolbar row when placed there', async () => {
    renderControls({ placement: 'toolbar' })

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    // 36px matches the other controls in the composer's toolbar; the standalone
    // line uses 40px for touch.
    expect(pill).toHaveClass('h-9')
    expect(pill).not.toHaveClass('h-10')
  })

  it('sizes the pill for touch when it stands on its own line', async () => {
    renderControls({ placement: 'outside' })

    const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
    expect(pill).toHaveClass('h-10')
  })

  // The dropdown used to close on its own `mousedown` listener, which does not
  // fire reliably for touch input — the "tapping outside doesn't close the
  // menu" shape of bug on the H5 build. `useDismissable` listens on
  // `pointerdown` instead, so this asserts the pointer event, not the mouse one.
  it('closes the menu on an outside pointerdown', async () => {
    renderControls()
    await openPill()
    expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)

    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })
  })

  it('keeps the menu open when the pointer goes down inside it', async () => {
    renderControls()
    await openPill()
    const menu = await screen.findByRole('menu', { name: 'Location' })

    fireEvent.pointerDown(menu)

    expect(screen.getByRole('menu', { name: 'Location' })).toBeInTheDocument()
  })

  // The nested directory picker portals its dropdown to the body, so without
  // the `isExempt` escape hatch a click inside it reads as "outside" this menu
  // and tears down the trigger that opened it.
  it('stays open while the nested directory picker is being used', async () => {
    renderControls()
    await openPill()
    await screen.findByRole('menu', { name: 'Location' })

    const pickerMenu = document.createElement('div')
    pickerMenu.setAttribute('data-testid', 'directory-picker-menu')
    const row = document.createElement('button')
    pickerMenu.appendChild(row)
    document.body.appendChild(pickerMenu)

    fireEvent.pointerDown(row)

    expect(screen.getByRole('menu', { name: 'Location' })).toBeInTheDocument()
    pickerMenu.remove()
  })

  it('closes the menu on Escape', async () => {
    renderControls()
    await openPill()
    await screen.findByRole('menu', { name: 'Location' })

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })
  })

  it('falls back to the folder name when the directory is not a git repo', async () => {
    apiMocks.getRepositoryContext.mockResolvedValue({
      state: 'not_git_repo',
      workDir: '/tmp/scratch',
      repoRoot: null,
      repoName: null,
      currentBranch: null,
      defaultBranch: null,
      dirty: false,
      branches: [],
      worktrees: [],
    })

    renderControls({ workDir: '/tmp/scratch', branch: null })

    const pill = await screen.findByRole('button', { name: 'Location: scratch' })
    expect(within(pill).getByText('scratch')).toBeInTheDocument()

    fireEvent.click(pill)
    const menu = await screen.findByRole('menu', { name: 'Location' })
    // No branch or worktree rows without a repo — only the directory.
    expect(within(menu).queryByRole('menuitem', { name: /Branch/ })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('menuitemradio')).not.toBeInTheDocument()
  })
})
