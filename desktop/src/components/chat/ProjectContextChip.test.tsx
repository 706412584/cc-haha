import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom'
import { ProjectContextChip } from './ProjectContextChip'

describe('ProjectContextChip', () => {
  it('shows only the source project label and worktree marker for isolated worktrees', () => {
    render(
      <ProjectContextChip
        workDir="/workspace/OpenCutSkill/.claude/worktrees/desktop-main-54a09f85"
        sourceWorkDir="/workspace/OpenCutSkill"
        repoName={null}
        branch="main"
        isWorktree
        worktreeSlug="desktop-main-54a09f85"
      />,
    )

    expect(screen.getByText('OpenCutSkill')).toBeInTheDocument()
    expect(screen.getByText('worktree')).toBeInTheDocument()
    expect(screen.queryByText('main')).not.toBeInTheDocument()
    expect(screen.queryByText('desktop-main-54a09f85')).not.toBeInTheDocument()
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
