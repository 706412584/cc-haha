import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import {
  captureProjectDisplayNameHydrationRevision,
  hydrateProjectDisplayNames,
} from '../../stores/projectDisplayNameStore'
import { ProjectContextChip } from './ProjectContextChip'

afterEach(() => {
  vi.useRealTimers()
})

describe('ProjectContextChip', () => {
  beforeEach(() => {
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
  })

  afterEach(() => {
    act(() => {
      hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
    })
  })

  it('shows only the source project label and worktree marker for isolated worktrees', () => {
    vi.useFakeTimers()
    render(
      <ProjectContextChip
        workDir="/workspace/OpenCutSkill/.claude/worktrees/desktop-main-54a09f85"
        sourceWorkDir="/workspace/OpenCutSkill"
        repoName={null}
        branch="main"
        isWorktree
        worktreeSlug="desktop-main-54a09f85"
        worktreePath="/workspace/OpenCutSkill/.claude/worktrees/desktop-main-54a09f85"
      />,
    )

    expect(screen.getByText('OpenCutSkill')).toBeInTheDocument()
    expect(screen.getByText('worktree')).toBeInTheDocument()
    expect(screen.queryByText('main')).not.toBeInTheDocument()
    expect(screen.queryByText('desktop-main-54a09f85')).not.toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByTestId('worktree-details-trigger'))
    act(() => { vi.advanceTimersByTime(400) })

    expect(screen.getByRole('tooltip')).toHaveTextContent('desktop-main-54a09f85')
    expect(screen.getByRole('tooltip')).toHaveTextContent('/workspace/OpenCutSkill/.claude/worktrees/desktop-main-54a09f85')
  })

  it('reveals the worktree name and directory from the compact marker', () => {
    vi.useFakeTimers()
    render(
      <ProjectContextChip
        variant="toolbar"
        workDir="/workspace/OpenCutSkill/.claude/worktrees/desktop-main-54a09f85"
        sourceWorkDir="/workspace/OpenCutSkill"
        repoName="OpenCutSkill"
        branch="main"
        isWorktree
        worktreeSlug={null}
        worktreePath={'C:\\workspace\\OpenCutSkill\\.claude\\worktrees\\desktop-main-54a09f85'}
      />,
    )

    const trigger = screen.getByTestId('worktree-details-trigger')
    expect(screen.getByTestId('run-location-readonly')).not.toHaveAttribute('title')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.focus(trigger)
    act(() => { vi.advanceTimersByTime(400) })

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('desktop-main-54a09f85')
    expect(tooltip).toHaveTextContent('C:\\workspace\\OpenCutSkill\\.claude\\worktrees\\desktop-main-54a09f85')
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
  })

  it('prioritizes the project-root display name and retains raw worktree context in its tooltip', () => {
    vi.useFakeTimers()
    const projectRoot = '/workspace/canonical-project'
    const sourceWorkDir = '/workspace/OpenCutSkill'
    const worktreePath = '/workspace/OpenCutSkill/.claude/worktrees/desktop-main-54a09f85'

    render(
      <ProjectContextChip
        workDir={worktreePath}
        projectRoot={projectRoot}
        repoName="OpenCutSkill"
        branch="main"
        sourceWorkDir={sourceWorkDir}
        isWorktree
        worktreeSlug="desktop-main-54a09f85"
        worktreePath={worktreePath}
      />,
    )

    const chip = screen.getByTestId('run-location-outside')
    expect(chip).toHaveTextContent('OpenCutSkill')

    act(() => {
      hydrateProjectDisplayNames(
        {
          [projectRoot]: 'OpenCut Studio',
          [sourceWorkDir]: 'Source project name',
        },
        captureProjectDisplayNameHydrationRevision(),
      )
    })

    expect(chip).toHaveTextContent('OpenCut Studio')
    expect(chip).not.toHaveTextContent('Source project name')

    // The alias replaces the folder name on the chip, so the real directory has
    // to stay reachable somewhere. For a worktree that is the details tooltip —
    // the chip itself carries no `title` in this mode.
    expect(chip).not.toHaveAttribute('title')
    fireEvent.mouseEnter(screen.getByTestId('worktree-details-trigger'))
    act(() => { vi.advanceTimersByTime(400) })

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent(projectRoot)
    expect(tooltip).toHaveTextContent(worktreePath)
  })

  it('does not show worktree details for a normal checkout', () => {
    render(
      <ProjectContextChip
        workDir="/workspace/OpenCutSkill"
        repoName={null}
        branch="main"
      />,
    )

    expect(screen.getByText('OpenCutSkill')).toBeInTheDocument()
    expect(screen.queryByText('worktree')).not.toBeInTheDocument()
  })

  // The toolbar variant shares a row with the model and run controls, so a
  // narrow composer column has to take width out of it. Asserted on the shrink
  // factors rather than on rendered widths because jsdom lays nothing out — and
  // when they matched, a narrow column truncated both halves at once and left
  // `cc-…/…n`, where neither the project nor the branch could be read.
  it('gives up branch width before project width in the toolbar row', () => {
    render(
      <ProjectContextChip
        variant="toolbar"
        workDir="/workspace/OpenCutSkill"
        repoName="OpenCutSkill"
        branch="feature/some-very-long-branch-name"
      />,
    )

    const project = screen.getByText('OpenCutSkill')
    const branch = screen.getByText('feature/some-very-long-branch-name').closest('span[dir="rtl"]')

    expect(project).toHaveClass('shrink', 'truncate')
    expect(branch).toHaveClass('shrink-[4]', 'truncate')
  })
})
