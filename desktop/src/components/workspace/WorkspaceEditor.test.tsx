import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { undo, undoDepth } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'

import globalsCss from '../../theme/globals.css?raw'

const mocks = vi.hoisted(() => ({
  saveWorkspaceFileMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  syncLspMock: vi.fn(),
  lspStateMock: vi.fn(),
  lspDiagnosticsMock: vi.fn(),
  restartLspMock: vi.fn(),
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    saveWorkspaceFile: mocks.saveWorkspaceFileMock,
    getWorkspaceLspState: mocks.lspStateMock,
    getWorkspaceLspDiagnostics: mocks.lspDiagnosticsMock,
    syncWorkspaceLsp: mocks.syncLspMock,
    restartWorkspaceLsp: mocks.restartLspMock,
  },
}))

import {
  useWorkspaceEditorStore,
  workspaceBufferKey,
} from '../../stores/workspaceEditorStore'
import { WorkspaceEditor } from './WorkspaceEditor'

/**
 * RTL tests for WorkspaceEditor (Phase 2 task 15).
 *
 * Strategy: drive the component with synthetic preview tabs so we don't
 * have to mount a full WorkspacePanel; mock only the save endpoint.
 *
 * **Validates Properties: 8** (dirty markers, save aborts close, unsupported
 * encoding fallback, conflict banner gates).
 *
 * _Requirements: 1.1-1.8, 4.1-4.6_
 */

type EditorFixture = { path: string; content: string }

function makeTab(overrides: Partial<EditorFixture> = {}): EditorFixture {
  return {
    path: 'src/app.ts',
    content: 'export const x = 1\n',
    ...overrides,
  }
}

/** The buffer key the editor store uses for a fixture. */
function keyOf(fixture: EditorFixture) {
  return workspaceBufferKey('s1', fixture.path)
}

function buffers() {
  return useWorkspaceEditorStore.getState().buffersByKey
}

describe('WorkspaceEditor', () => {
  const initialState = useWorkspaceEditorStore.getInitialState()

  beforeEach(() => {
    mocks.saveWorkspaceFileMock.mockReset()
    mocks.syncLspMock.mockReset()
    mocks.saveWorkspaceFileMock.mockResolvedValue({
      ok: true,
      hash: 'a'.repeat(64),
      bytes: 19,
      timestamp: Date.now(),
    })
    useWorkspaceEditorStore.setState(initialState, true)
  })

  afterEach(() => {
    useWorkspaceEditorStore.setState(initialState, true)
    document.documentElement.removeAttribute('data-theme')
    vi.restoreAllMocks()
  })

  it.each([
    {
      title: 'TypeScript',
      tab: makeTab({
        content: 'export type Result = { ok: boolean }\nconst result: Result = { ok: true }\n',
      }),
      tokens: [
        { text: 'export', className: 'workspace-syntax-keyword', color: '--color-code-keyword' },
        { text: 'Result', className: 'workspace-syntax-type', color: '--color-code-type' },
        { text: 'true', className: 'workspace-syntax-bool', color: '--color-code-number' },
      ],
    },
    {
      title: 'JSON',
      tab: makeTab({
        path: 'config.json',
        content: '{ "enabled": true, "retries": 3 }\n',
      }),
      tokens: [
        { text: '"enabled"', className: 'workspace-syntax-property', color: '--color-code-property' },
        { text: 'true', className: 'workspace-syntax-bool', color: '--color-code-number' },
        { text: '3', className: 'workspace-syntax-number', color: '--color-code-number' },
      ],
    },
    // The editor used to map ten extensions by hand, so every other file opened
    // with no grammar and rendered as one flat colour — while the same file
    // highlighted correctly in the read-only preview. These lock the coverage
    // that brought the two surfaces back in line.
    {
      title: 'Python',
      tab: makeTab({ path: 'worker.py', content: 'def run(limit):\n    return limit + 1\n' }),
      tokens: [{ text: 'def', className: 'workspace-syntax-keyword', color: '--color-code-keyword' }],
    },
    {
      title: 'Go',
      tab: makeTab({ path: 'main.go', content: 'package main\n\nfunc main() { return }\n' }),
      tokens: [{ text: 'package', className: 'workspace-syntax-keyword', color: '--color-code-keyword' }],
    },
    {
      title: 'Rust',
      tab: makeTab({ path: 'lib.rs', content: 'pub fn total() -> u32 { 1 }\n' }),
      tokens: [{ text: 'pub', className: 'workspace-syntax-keyword', color: '--color-code-keyword' }],
    },
    {
      title: 'CSS',
      tab: makeTab({ path: 'theme.css', content: '.card { color: red; }\n' }),
      // The selector's class name token excludes the leading dot, which is
      // punctuation of its own.
      tokens: [
        { text: 'card', className: 'workspace-syntax-type', color: '--color-code-type' },
        { text: 'color', className: 'workspace-syntax-property', color: '--color-code-property' },
      ],
    },
    {
      title: 'YAML',
      tab: makeTab({ path: 'ci.yaml', content: 'name: build\njobs: []\n' }),
      tokens: [{ text: 'name', className: 'workspace-syntax-property', color: '--color-code-property' }],
    },
    {
      title: 'SQL',
      tab: makeTab({ path: 'schema.sql', content: 'SELECT id FROM users\n' }),
      tokens: [{ text: 'SELECT', className: 'workspace-syntax-keyword', color: '--color-code-keyword' }],
    },
    // Shell has no `lang-*` package; it highlights through a legacy stream mode.
    {
      title: 'Shell (legacy mode)',
      tab: makeTab({ path: 'run.sh', content: 'if [ -f "$1" ]; then echo ok; fi\n' }),
      tokens: [{ text: 'if', className: 'workspace-syntax-keyword', color: '--color-code-keyword' }],
    },
    {
      title: 'C# (legacy mode)',
      tab: makeTab({ path: 'Program.cs', content: 'public class Program { }\n' }),
      tokens: [{ text: 'public', className: 'workspace-syntax-keyword', color: '--color-code-keyword' }],
    },
  ])('renders $title tokens with semantic syntax classes and CSS-variable colors', async ({ tab, tokens }) => {
    const { container } = render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} />)

    // The grammar is fetched as a chunk after the view mounts, so the editor
    // element existing does not mean the tokens are classified yet.
    await waitFor(() => {
      expect(container.querySelector('.cm-editor')).toBeTruthy()
      const classified = Array.from(container.querySelectorAll('[class*="workspace-syntax-"]'))
      expect(classified.length).toBeGreaterThan(0)
    })

    for (const token of tokens) {
      const element = Array.from(container.querySelectorAll(`.${token.className}`))
        .find((candidate) => candidate.textContent === token.text)
      expect(element).toBeTruthy()
      expect(globalsCss).toMatch(
        new RegExp(`\\.${token.className}[^}]*color: var\\(${token.color}\\);`),
      )
    }
  })

  // An extension with no grammar must still open: the file is readable and
  // editable as plain text, and nothing throws while the lookup comes up empty.
  it('opens a file whose extension has no grammar as plain text', async () => {
    const { container } = render(
      <WorkspaceEditor sessionId="s1" path="mystery.xyz" content={'some opaque payload\n'} />,
    )

    await waitFor(() => {
      expect(container.querySelector('.cm-editor')).toBeTruthy()
    })
    await waitFor(() => {
      expect(container.querySelector('.cm-content')?.textContent).toContain('some opaque payload')
    })
    expect(container.querySelector('[class*="workspace-syntax-"]')).toBeNull()
  })


  it.each(['light', 'dark', 'eyeCare'])('keeps editor state and history when switching to %s theme', async (theme) => {
    document.documentElement.setAttribute('data-theme', 'white')
    const tab = makeTab()
    const { container } = render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} />)

    await waitFor(() => {
      expect(container.querySelector('.cm-editor')).toBeTruthy()
    })
    const editorElement = container.querySelector<HTMLElement>('.cm-editor')!
    const view = EditorView.findFromDOM(editorElement)!
    expect(view).toBeTruthy()

    act(() => {
      view.dispatch({
        changes: { from: 17, to: 18, insert: '2' },
        selection: { anchor: 18 },
      })
    })
    const dirtyBuffer = buffers()[keyOf(tab)]
    expect(dirtyBuffer?.currentContent).toBe('export const x = 2\n')
    expect(dirtyBuffer?.isDirty).toBe(true)
    expect(undoDepth(view.state)).toBe(1)

    act(() => {
      document.documentElement.setAttribute('data-theme', theme)
    })

    expect(container.querySelector('.cm-editor')).toBe(editorElement)
    expect(EditorView.findFromDOM(editorElement)).toBe(view)
    expect(view.state.doc.toString()).toBe('export const x = 2\n')
    expect(view.state.selection.main.anchor).toBe(18)
    expect(buffers()[keyOf(tab)]).toMatchObject({
      currentContent: 'export const x = 2\n',
      isDirty: true,
    })
    expect(undoDepth(view.state)).toBe(1)

    act(() => {
      expect(undo(view)).toBe(true)
    })
    expect(view.state.doc.toString()).toBe('export const x = 1\n')
  })

  it('initializes the buffer with detected encoding and line ending', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} />)

    await waitFor(() => {
      const buffer = buffers()[keyOf(tab)]
      expect(buffer).toBeDefined()
      expect(buffer?.encoding).toBe('utf-8')
      expect(buffer?.lineEnding).toBe('LF')
      expect(buffer?.isDirty).toBe(false)
    })

    expect(screen.getByTestId('workspace-editor-path').textContent?.trim()).toBe('src/app.ts')
  })

  it('renders the unsupported-encoding fallback for non-UTF-8 buffers', async () => {
    const tab = makeTab({
      // String containing a stray 0xE9 (Latin-1 é); when re-encoded to bytes
      // it produces a sequence that detectEncoding rejects as unsupported.
      content: 'naive \u0080 buffer',
    })
    // Force the encoder to produce an invalid sequence by stubbing TextEncoder
    // with a mock that returns the lone 0x80 byte.
    const realEncoder = global.TextEncoder
    class StubEncoder {
      encoding = 'utf-8'
      encode(): Uint8Array {
        return new Uint8Array([0x80, 0x61])
      }
      encodeInto(): { read: number; written: number } {
        return { read: 0, written: 0 }
      }
    }
    // @ts-expect-error — narrow override for the duration of the test
    global.TextEncoder = StubEncoder

    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} />)

    await waitFor(() => {
      expect(screen.queryByTestId('workspace-editor-unsupported')).toBeTruthy()
    })

    global.TextEncoder = realEncoder
  })

  it('shows the dirty marker after a buffer edit', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} />)

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]).toBeDefined()
    })

    act(() => {
      useWorkspaceEditorStore.getState().setBufferState(keyOf(tab), 'export const x = 2\n')
    })

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]?.isDirty).toBe(true)
    })

    await waitFor(() => {
      expect(screen.getByTestId('workspace-editor-path').textContent).toContain('●')
    })
  })

  it('opens the unsaved-changes modal when closing a dirty buffer', async () => {
    const tab = makeTab()
    const onClose = vi.fn()
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} onClose={onClose} />)

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]).toBeDefined()
    })
    act(() => {
      useWorkspaceEditorStore.getState().setBufferState(keyOf(tab), 'edited')
    })

    fireEvent.click(screen.getByTestId('workspace-editor-close'))

    expect(screen.getByTestId('unsaved-changes-modal')).toBeTruthy()
    expect(screen.getByTestId('unsaved-changes-cancel')).toBeTruthy()
    expect(screen.getByTestId('unsaved-changes-save')).toBeTruthy()
    expect(screen.getByTestId('unsaved-changes-discard')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes immediately for a clean buffer without showing the modal', async () => {
    const tab = makeTab()
    const onClose = vi.fn()
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} onClose={onClose} />)

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]).toBeDefined()
    })

    fireEvent.click(screen.getByTestId('workspace-editor-close'))

    expect(screen.queryByTestId('unsaved-changes-modal')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the modal interactive when no save is in flight (Cancel/Discard enabled)', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]).toBeDefined()
    })
    act(() => {
      useWorkspaceEditorStore.getState().setBufferState(keyOf(tab), 'edited')
    })

    fireEvent.click(screen.getByTestId('workspace-editor-close'))
    expect((screen.getByTestId('unsaved-changes-cancel') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('unsaved-changes-discard') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('unsaved-changes-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('saves dirty buffers, resets dirty state, syncs LSP content, and calls onSaved', async () => {
    const tab = makeTab()
    const onSaved = vi.fn()
    useWorkspaceEditorStore.setState({ syncLsp: mocks.syncLspMock }, false)
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} onSaved={onSaved} />)

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]).toBeDefined()
    })
    act(() => {
      useWorkspaceEditorStore.getState().setBufferState(keyOf(tab), 'export const x = 2\n')
    })

    fireEvent.click(screen.getByTestId('workspace-editor-save'))

    await waitFor(() => {
      expect(mocks.saveWorkspaceFileMock).toHaveBeenCalledWith('s1', expect.objectContaining({
        path: 'src/app.ts',
        content: 'export const x = 2\n',
        expectedBaseHash: expect.any(String),
        bom: 'none',
        lineEnding: 'LF',
      }))
      expect(buffers()[keyOf(tab)]?.isDirty).toBe(false)
      expect(onSaved).toHaveBeenCalledWith('src/app.ts')
      expect(mocks.syncLspMock).toHaveBeenCalledWith('s1', {
        path: 'src/app.ts',
        content: 'export const x = 2\n',
        event: 'save',
      })
    })
  })

  it('keeps dirty state and skips onSaved when save fails', async () => {
    mocks.saveWorkspaceFileMock.mockResolvedValueOnce({ ok: false, error: 'stale_base', message: 'File changed on disk' })
    const tab = makeTab()
    const onSaved = vi.fn()
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} onSaved={onSaved} />)

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]).toBeDefined()
    })
    act(() => {
      useWorkspaceEditorStore.getState().setBufferState(keyOf(tab), 'edited')
    })

    fireEvent.click(screen.getByTestId('workspace-editor-save'))

    await waitFor(() => {
      expect(screen.getByTestId('workspace-editor-save-error').textContent).toContain('File changed on disk')
      expect(buffers()[keyOf(tab)]?.isDirty).toBe(true)
      expect(onSaved).not.toHaveBeenCalled()
    })
  })

  it('renders the conflict banner when buffer.conflict is set', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} />)

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]).toBeDefined()
    })

    act(() => {
      useWorkspaceEditorStore.getState().applyExternalSave(keyOf(tab), {
        source: 'user',
        hash: 'c'.repeat(64),
        timestamp: Date.now(),
      })
    })

    expect(screen.getByTestId('workspace-conflict-banner')).toBeTruthy()
    // Clean buffer -> single Reload button.
    expect(screen.getByTestId('conflict-reload')).toBeTruthy()
    expect(screen.queryByTestId('conflict-keep-mine')).toBeNull()
  })

  it('shows three banner buttons when the buffer is dirty at conflict time', async () => {
    const tab = makeTab()
    render(<WorkspaceEditor sessionId="s1" path={tab.path} content={tab.content} />)

    await waitFor(() => {
      expect(buffers()[keyOf(tab)]).toBeDefined()
    })

    act(() => {
      useWorkspaceEditorStore.getState().setBufferState(keyOf(tab), 'edited')
      useWorkspaceEditorStore.getState().applyExternalSave(keyOf(tab), {
        source: 'user',
        hash: 'c'.repeat(64),
        timestamp: Date.now(),
      })
    })

    expect(screen.getByTestId('conflict-reload')).toBeTruthy()
    expect(screen.getByTestId('conflict-keep-mine')).toBeTruthy()
    expect(screen.getByTestId('conflict-open-view')).toBeTruthy()
  })
})
