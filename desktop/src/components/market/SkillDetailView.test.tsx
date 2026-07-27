import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, variant }: { content: string; variant?: string }) => (
    <div data-testid="markdown-renderer" data-content={content} data-variant={variant} />
  ),
}))

vi.mock('../chat/CodeViewer', () => ({
  CodeViewer: ({ code, showLineNumbers }: { code: string; showLineNumbers?: boolean }) => (
    <div data-testid="code-viewer" data-line-numbers={String(showLineNumbers)}>{code}</div>
  ),
}))

import { SkillDetailView } from './SkillDetailView'
import { useSettingsStore } from '../../stores/settingsStore'
import type { PreviewFileContent } from './FilePreview'

const FILES = [
  { path: 'SKILL.md', size: 100, language: 'markdown' },
  { path: 'scripts/run.py', size: 200, language: 'python' },
]

function loadFileFromMemory(path: string): Promise<PreviewFileContent> {
  if (path === 'SKILL.md') {
    return Promise.resolve({ path, content: '# Overview doc', language: 'markdown', size: 100, truncated: false })
  }
  return Promise.resolve({ path, content: 'print("hi")', language: 'python', size: 200, truncated: true })
}

function renderView(overrides: Partial<Parameters<typeof SkillDetailView>[0]> = {}) {
  return render(
    <SkillDetailView
      name="Demo Skill"
      version="1.0.0"
      sourceLabel="ClawHub"
      summary="A demo"
      securityStatus="benign"
      installState="installable"
      meta={[{ label: 'Author', value: 'Alice' }]}
      description="# Body"
      files={FILES}
      loadFile={loadFileFromMemory}
      onBack={vi.fn()}
      backLabel="Back"
      {...overrides}
    />,
  )
}

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

describe('SkillDetailView', () => {
  it('renders the decision header with badges and the overview markdown', () => {
    renderView()

    expect(screen.getByText('Demo Skill')).toBeInTheDocument()
    expect(screen.getByText('v1.0.0')).toBeInTheDocument()
    expect(screen.getByTestId('security-badge-benign')).toBeInTheDocument()
    expect(screen.getByTestId('install-badge-installable')).toBeInTheDocument()
    const markdown = screen.getByTestId('markdown-renderer')
    expect(markdown).toHaveAttribute('data-content', '# Body')
    expect(markdown).toHaveAttribute('data-variant', 'document')
  })

  it('shows the not-installable reason prominently', () => {
    renderView({ installState: 'not-installable', notInstallableReason: 'name-conflict' })

    expect(screen.getByTestId('market-not-installable-reason')).toHaveTextContent(
      'A local skill with the same name already exists',
    )
  })

  it('lists security reports with links', () => {
    renderView({
      securityReports: [
        { vendor: 'keen', status: 'benign', statusText: 'Safe', reportUrl: 'https://example.com/report' },
      ],
    })

    expect(screen.getByTestId('market-security-reports')).toHaveTextContent('keen')
    expect(screen.getByRole('link', { name: 'View report' })).toHaveAttribute('href', 'https://example.com/report')
  })

  it('switches to the files tab and previews code with line numbers and truncation notice', async () => {
    renderView()

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))
    expect(await screen.findByTestId('market-file-preview')).toBeInTheDocument()
    // SKILL.md is auto-selected → markdown preview
    expect(await screen.findAllByTestId('markdown-renderer')).toBeTruthy()

    fireEvent.click(screen.getByTestId('market-file-item-scripts/run.py'))
    const code = await screen.findByTestId('code-viewer')
    expect(code).toHaveTextContent('print("hi")')
    expect(code).toHaveAttribute('data-line-numbers', 'true')
    expect(screen.getByText(/Preview truncated/)).toBeInTheDocument()
  })

  it('shows a file load error with retry', async () => {
    const failingLoad = vi.fn().mockRejectedValue(new Error('fetch failed'))
    renderView({ loadFile: failingLoad })

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))
    expect(await screen.findByTestId('market-file-error')).toHaveTextContent('Failed to load this file')
    expect(screen.getByText('fetch failed')).toBeInTheDocument()
  })

  it('renders custom actions in the decision area', () => {
    renderView({ actions: <button type="button">Install now</button> })

    const decisionSidebar = screen.getByTestId('skill-detail-sidebar')
    expect(within(decisionSidebar).getByText('Install now')).toBeInTheDocument()
    expect(within(decisionSidebar).getByText('Author')).toBeInTheDocument()
    expect(within(decisionSidebar).getByText('Alice')).toBeInTheDocument()
  })

  it('lifts SKILL.md frontmatter out of the overview markdown into the sidebar rail', () => {
    renderView({
      description: ['---', 'name: find-skills', 'model: opus', 'tags: ["a","b"]', '---', '', '# Body'].join('\n'),
    })

    // The YAML must not reach the renderer — markdown turns it into a heading.
    expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-content', '# Body')

    // Metadata is reference material: it sits with the other attributes, and
    // never ahead of the document that says what the skill does.
    const overview = screen.getByTestId('skill-detail-overview')
    expect(within(overview).queryByTestId('skill-frontmatter-panel')).not.toBeInTheDocument()

    const panel = within(screen.getByTestId('skill-detail-sidebar')).getByTestId('skill-frontmatter-panel')
    expect(within(panel).getByText('model')).toBeInTheDocument()
    expect(within(panel).getByText('opus')).toBeInTheDocument()
    // `name` duplicates the header, so it is filtered out.
    expect(within(panel).queryByText('name')).not.toBeInTheDocument()
  })

  it('keeps the metadata rail below the market meta it belongs with', () => {
    renderView({
      description: '---\nmodel: opus\n---\n# Body',
      meta: [{ label: 'Author', value: 'Alice' }],
    })

    const sidebar = screen.getByTestId('skill-detail-sidebar')
    const author = within(sidebar).getByText('Author')
    const panel = within(sidebar).getByTestId('skill-frontmatter-panel')

    expect(author.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows frontmatter the caller parsed upstream when the description has none', () => {
    renderView({ description: '# Body', descriptionFrontmatter: { model: 'opus' } })

    expect(screen.getByTestId('skill-frontmatter-panel')).toHaveTextContent('opus')
    expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-content', '# Body')
  })

  it('prefers frontmatter embedded in the description over the caller-supplied copy', () => {
    renderView({
      description: '---\nmodel: sonnet\n---\n# Body',
      descriptionFrontmatter: { model: 'opus' },
    })

    const panel = screen.getByTestId('skill-frontmatter-panel')
    expect(panel).toHaveTextContent('sonnet')
    expect(panel).not.toHaveTextContent('opus')
  })

  it('omits the metadata panel when there is no frontmatter at all', () => {
    renderView({ description: '# Body' })

    expect(screen.queryByTestId('skill-frontmatter-panel')).not.toBeInTheDocument()
  })

  it('still shows the empty-description notice when only frontmatter is present', () => {
    renderView({ description: '---\nmodel: opus\n---\n' })

    expect(screen.getByText('This skill provides no description.')).toBeInTheDocument()
    expect(screen.getByTestId('skill-frontmatter-panel')).toBeInTheDocument()
  })

  it('splits frontmatter out of markdown files in the files tab too', async () => {
    const loadFile = (path: string) =>
      Promise.resolve({
        path,
        content: '---\nmodel: opus\n---\n# Skill body',
        language: 'markdown',
        size: 42,
        truncated: false,
      })
    // No sidebar copy here, so the only panel found must be the file's own.
    renderView({ loadFile, description: '# Overview', meta: [] })

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))

    const preview = await screen.findByTestId('market-file-preview')
    expect(await within(preview).findByTestId('skill-frontmatter-panel')).toHaveTextContent('opus')
    const rendered = await screen.findAllByTestId('markdown-renderer')
    expect(rendered.some((node) => node.getAttribute('data-content') === '# Skill body')).toBe(true)
  })

  it('lets the files tab fill the available height instead of a fixed-height box', async () => {
    renderView()

    fireEvent.click(screen.getByTestId('skill-detail-tab-files'))

    // A hard-coded max-height left the lower half of the page empty; the panel
    // now grows with its flex parent.
    const preview = await screen.findByTestId('market-file-preview')
    expect(screen.getByTestId('skill-detail-files').className).toContain('flex-1')
    expect(preview.className).toContain('flex-1')
    expect(preview.className).not.toContain('max-h-[520px]')
  })
})
