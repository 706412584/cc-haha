import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
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
// nothing and the real panel renders. It moved to composite/ in the directory
// reshuffle and this path was left behind.
vi.mock('@/components/composite/DirectoryPicker', () => ({
  RecentProjectsPanel: ({ value, onSelect }: { value: string; onSelect: (path: string) => void }) => (
    <div data-testid="recent-projects-panel">
      <span>Current {value || 'none'}</span>
      <button type="button" onClick={() => onSelect('/repo')}>Pick /repo</button>
      <button type="button" onClick={() => onSelect('/tmp/plain')}>Pick /tmp/plain</button>
    </div>
  ),
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => ({
    'common.loading': 'Loading',
    'dirPicker.directory': 'Directory',
    'dirPicker.selectProject': 'Select a project',
    'repoLaunch.branch': 'Branch',
    'repoLaunch.checkedOut': 'Checked out',
    'repoLaunch.checkedOutWarning': 'Branch is checked out elsewhere',
    'repoLaunch.checkedOutWarningCompact': 'Branch already checked out',
    'repoLaunch.currentBranch': 'Current branch',
    'repoLaunch.dirtyWarning': 'Dirty worktree',
    'repoLaunch.dirtyWarningCompact': 'Uncommitted changes',
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

function notGitContext(workDir: string) {
  return {
    state: 'not_git_repo' as const,
    workDir,
    repoRoot: null,
    repoName: null,
    currentBranch: null,
    defaultBranch: null,
    dirty: false,
    branches: [],
    worktrees: [],
  }
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

/**
 * The pill drives `workDir` through its parent, so anything that asserts what
 * happens *after* a directory is picked needs the prop to actually come back
 * down changed.
 */
function ControlledHarness({ initialWorkDir = '' }: { initialWorkDir?: string }) {
  const [workDir, setWorkDir] = useState(initialWorkDir)
  const [branch, setBranch] = useState<string | null>(null)

  return (
    <RepositoryLaunchControls
      workDir={workDir}
      onWorkDirChange={setWorkDir}
      branch={branch}
      onBranchChange={setBranch}
      useWorktree={false}
      onUseWorktreeChange={vi.fn()}
    />
  )
}

/** Opens the pill's root menu. */
async function openPill() {
  const pill = await screen.findByRole('button', { name: 'Location: cc-haha / main' })
  fireEvent.click(pill)
  return pill
}

/** Opens the pill on a fresh session, where it lands on the directory list. */
async function openEmptyPill() {
  const pill = await screen.findByRole('button', { name: 'Location: Select a project' })
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
    expect(within(menu).getByRole('menuitem', { name: /Directory/ })).toBeInTheDocument()
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

  it('keeps a dirty-branch warning compact and inline in the toolbar', async () => {
    apiMocks.getRepositoryContext.mockResolvedValue({
      ...okRepositoryContext,
      dirty: true,
    })

    renderControls({ branch: 'feature/h5', placement: 'toolbar' })

    const warning = await screen.findByRole('status', { name: 'Dirty worktree' })
    expect(warning).toHaveTextContent('Uncommitted changes')
    expect(warning).toHaveAttribute('title', 'Dirty worktree')
    expect(within(warning).getByText('Uncommitted changes')).toHaveClass('hidden', '2xl:inline')
    expect(warning.parentElement).toHaveClass('flex-row')
    expect(screen.queryByText('Dirty worktree')).not.toBeInTheDocument()
  })

  it('keeps the complete dirty-branch explanation outside the toolbar', async () => {
    apiMocks.getRepositoryContext.mockResolvedValue({
      ...okRepositoryContext,
      dirty: true,
    })

    renderControls({ branch: 'feature/h5', placement: 'outside' })

    expect(await screen.findByRole('status', { name: 'Dirty worktree' }))
      .toHaveTextContent('Dirty worktree')
    expect(screen.queryByText('Uncommitted changes')).not.toBeInTheDocument()
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

  // The directory list used to be a nested picker that portalled its own
  // dropdown to the body, so a pointer down inside it read as "outside" this
  // menu and needed an `isExempt` escape hatch to avoid tearing down the
  // trigger that opened it. It is one of this menu's own views now.
  it('stays open while the directory view is being used', async () => {
    renderControls()
    await openPill()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Directory/ }))

    const panel = await screen.findByTestId('recent-projects-panel')
    fireEvent.pointerDown(panel)

    expect(screen.getByTestId('recent-projects-panel')).toBeInTheDocument()
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
    // No branch or worktree rows without a repo, so the root view would hold a
    // lone directory row — the menu opens on the directory list instead.
    expect(await screen.findByTestId('recent-projects-panel')).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
  })

  /**
   * The pill's menu was built around a repo it already had: directory, branch
   * and worktree. In a fresh session `isGitReady` is false, both of the latter
   * are gone, and the root view collapsed to a single "Directory" row that
   * existed only to open a second dropdown. These pin the escape from it.
   */
  describe('directory view', () => {
    it('opens straight on the directory list when no directory is picked yet', async () => {
      renderControls({ workDir: '', branch: null })
      await openEmptyPill()

      expect(await screen.findByTestId('recent-projects-panel')).toBeInTheDocument()
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
    })

    it('offers no way back to the root view while it would still be empty', async () => {
      renderControls({ workDir: '', branch: null })
      await openEmptyPill()
      await screen.findByTestId('recent-projects-panel')

      // Going back would land on the single-row shell this view exists to skip.
      expect(screen.queryByRole('button', { name: 'Directory' })).not.toBeInTheDocument()
    })

    it('drills into the directory view and back out again once there is a repo', async () => {
      renderControls()
      await openPill()
      fireEvent.click(await screen.findByRole('menuitem', { name: /Directory/ }))

      expect(await screen.findByTestId('recent-projects-panel')).toBeInTheDocument()
      expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Directory' }))

      expect(await screen.findByRole('menu', { name: 'Location' })).toBeInTheDocument()
      expect(screen.queryByTestId('recent-projects-panel')).not.toBeInTheDocument()
    })

    it('reveals branch and worktree in the root view after a repo is picked', async () => {
      render(<ControlledHarness />)
      await openEmptyPill()
      fireEvent.click(await screen.findByRole('button', { name: 'Pick /repo' }))

      // The menu stays open and swings back to the root view, where the rows
      // that were missing a moment ago are now populated.
      const menu = await screen.findByRole('menu', { name: 'Location' })
      expect(await within(menu).findByRole('menuitem', { name: /Branch/ })).toBeInTheDocument()
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2)
    })

    it('closes the menu when the picked directory turns out not to be a repo', async () => {
      apiMocks.getRepositoryContext.mockResolvedValue({
        state: 'not_git_repo',
        workDir: '/tmp/plain',
        repoRoot: null,
        repoName: null,
        currentBranch: null,
        defaultBranch: null,
        dirty: false,
        branches: [],
        worktrees: [],
      })

      render(<ControlledHarness />)
      await openEmptyPill()
      fireEvent.click(await screen.findByRole('button', { name: 'Pick /tmp/plain' }))

      // Nothing left to reveal, so holding the menu open would just be a shell.
      await waitFor(() => {
        expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
      })
      expect(screen.queryByTestId('recent-projects-panel')).not.toBeInTheDocument()
    })

    /**
     * On the render right after a pick, `context` still describes the *old*
     * directory and `loading` has not flipped to true yet. Resolving the
     * pending pick against it decides on the wrong repo — and because the
     * pending state is cleared at the same time, nothing ever corrects it.
     * Both directions below fail in opposite ways without the identity check.
     */
    it('does not judge a plain folder by the repo it replaced', async () => {
      apiMocks.getRepositoryContext.mockImplementation(async (dir: string) => (
        dir === '/repo' ? okRepositoryContext : notGitContext(dir)
      ))

      render(<ControlledHarness initialWorkDir="/repo" />)
      await openPill()
      fireEvent.click(await screen.findByRole('menuitem', { name: /Directory/ }))
      fireEvent.click(await screen.findByRole('button', { name: 'Pick /tmp/plain' }))

      // Reading the stale `ok` context here would hold the menu open on the
      // old repo's branch and worktree rows.
      await waitFor(() => {
        expect(screen.queryByRole('menu', { name: 'Location' })).not.toBeInTheDocument()
      })
      expect(screen.queryByTestId('recent-projects-panel')).not.toBeInTheDocument()
    })

    it('does not judge a repo by the plain folder it replaced', async () => {
      apiMocks.getRepositoryContext.mockImplementation(async (dir: string) => (
        dir === '/repo' ? okRepositoryContext : notGitContext(dir)
      ))

      render(<ControlledHarness initialWorkDir="/tmp/plain" />)
      fireEvent.click(await screen.findByRole('button', { name: 'Location: plain' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Pick /repo' }))

      // Reading the stale `not_git_repo` context here would close the menu on
      // a repo that does have a branch and worktree modes to offer.
      const menu = await screen.findByRole('menu', { name: 'Location' })
      expect(await within(menu).findByRole('menuitem', { name: /Branch/ })).toBeInTheDocument()
      expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2)
    })
  })
})
