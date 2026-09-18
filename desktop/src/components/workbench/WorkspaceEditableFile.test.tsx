import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The editor, the read-only surfaces, and the LSP pill all have their own
 * suites. They are stubbed here so these cases stay about the one decision this
 * component makes: which surface a file is shown on, and which modes it offers.
 */
vi.mock('../workspace/WorkspaceEditor', () => ({
  WorkspaceEditor: ({ path }: { path: string }) => (
    <div data-testid="workspace-editor" data-path={path} />
  ),
}))

vi.mock('../workspace/surfaces/MarkdownSurface', () => ({
  MarkdownSurface: ({ value, workDir }: { value: string; workDir?: string | null }) => (
    <div data-testid="markdown-surface" data-workdir={workDir ?? ''}>{value}</div>
  ),
}))

vi.mock('../workspace/surfaces/CodeSurface', () => ({
  CodeSurface: ({ value, language }: { value: string; language: string }) => (
    <div data-testid="code-surface" data-language={language}>{value}</div>
  ),
}))

vi.mock('../workspace/LspStatusIndicator', () => ({
  LspStatusIndicator: () => <div data-testid="lsp-pill" />,
}))

import { useWorkspaceEditorStore } from '../../stores/workspaceEditorStore'
import { WorkspaceEditableFile } from './WorkspaceEditableFile'

const SESSION = 'session-a'

function renderFile(overrides: Partial<Parameters<typeof WorkspaceEditableFile>[0]> = {}) {
  return render(
    <WorkspaceEditableFile
      sessionId={SESSION}
      path="notes.md"
      value="# Title"
      language="markdown"
      variant="markdown"
      workDir="/repo"
      {...overrides}
    />,
  )
}

beforeEach(() => {
  useWorkspaceEditorStore.setState({
    buffersByKey: {},
    unsupportedKeys: {},
    lspStateBySession: {},
    lspDiagnosticsBySessionPath: {},
  })
})

afterEach(() => {
  cleanup()
})

describe('WorkspaceEditableFile markdown modes', () => {
  it('offers split alongside preview and edit, starting on preview', () => {
    renderFile()

    expect(screen.getByTestId('workspace-file-preview-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('workspace-file-edit-toggle')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('workspace-file-split-toggle')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('markdown-surface')).toBeInTheDocument()
  })

  // The whole point of split: the source and its rendered form are on screen
  // together, so the document can be written while its result is visible.
  it('shows the editor and the rendered preview side by side', () => {
    renderFile()

    fireEvent.click(screen.getByTestId('workspace-file-split-toggle'))

    const split = screen.getByTestId('workspace-split')
    expect(split).toContainElement(screen.getByTestId('workspace-editor'))
    expect(split).toContainElement(screen.getByTestId('markdown-surface'))
    expect(screen.getByTestId('workspace-file-split-toggle')).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders only the editor in edit mode and only the preview in preview mode', () => {
    renderFile()

    fireEvent.click(screen.getByTestId('workspace-file-edit-toggle'))
    expect(screen.getByTestId('workspace-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown-surface')).toBeNull()

    fireEvent.click(screen.getByTestId('workspace-file-preview-toggle'))
    expect(screen.queryByTestId('workspace-editor')).toBeNull()
    expect(screen.getByTestId('markdown-surface')).toBeInTheDocument()
  })

  // Preview used to be unreachable while editing, and the buffer was not
  // reflected anywhere, so unsaved work looked discarded when switching back.
  it('previews the unsaved buffer rather than the bytes last read from disk', () => {
    useWorkspaceEditorStore.setState({
      buffersByKey: {
        [`${SESSION}::notes.md`]: {
          key: `${SESSION}::notes.md`,
          path: 'notes.md',
          baseContent: '# Title',
          currentContent: '# Edited but unsaved',
          baseHash: 'hash',
          encoding: 'utf-8',
          lineEnding: 'lf',
        },
      },
    } as never)

    renderFile()

    expect(screen.getByTestId('markdown-surface')).toHaveTextContent('# Edited but unsaved')
  })

  it('passes the workspace root through for relative image paths', () => {
    renderFile({ workDir: '/workspace/root' })

    expect(screen.getByTestId('markdown-surface')).toHaveAttribute('data-workdir', '/workspace/root')
  })

  // A markdown document has no language server; showing the pill would report
  // "not available" on every file the user opens.
  it('omits the language-server pill for markdown', () => {
    renderFile()
    expect(screen.queryByTestId('lsp-pill')).toBeNull()
  })
})

describe('WorkspaceEditableFile code variant', () => {
  it('keeps the two-mode switch and the code surface', () => {
    render(
      <WorkspaceEditableFile
        sessionId={SESSION}
        path="src/app.ts"
        value="const x = 1"
        language="typescript"
      />,
    )

    expect(screen.getByTestId('workspace-file-preview-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-file-edit-toggle')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-file-split-toggle')).toBeNull()
    expect(screen.getByTestId('code-surface')).toHaveTextContent('const x = 1')
  })

  it('still shows the language-server pill for code', () => {
    render(
      <WorkspaceEditableFile
        sessionId={SESSION}
        path="src/app.ts"
        value="const x = 1"
        language="typescript"
      />,
    )

    expect(screen.getByTestId('lsp-pill')).toBeInTheDocument()
  })
})

describe('WorkspaceEditableFile unsupported encoding', () => {
  it('disables editing and split, and falls back to the preview', () => {
    useWorkspaceEditorStore.setState({ unsupportedKeys: { [`${SESSION}::notes.md`]: true } })

    renderFile()

    expect(screen.getByTestId('workspace-file-edit-toggle')).toBeDisabled()
    expect(screen.getByTestId('workspace-file-split-toggle')).toBeDisabled()
    expect(screen.getByTestId('workspace-file-preview-toggle')).toHaveAttribute('aria-pressed', 'true')
  })
})
