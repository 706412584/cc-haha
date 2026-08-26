import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queueComposerPrefill } = vi.hoisted(() => ({
  queueComposerPrefill: vi.fn(),
}))

vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({ queueComposerPrefill }),
  },
}))

vi.mock('./ImageAnnotationModal', () => ({
  ImageAnnotationModal: ({ open, image, onSave }: {
    open: boolean
    image: { name: string } | null
    onSave: (dataUrl: string) => void
  }) => open ? (
    <button type="button" onClick={() => onSave('data:image/png;base64,ANNOTATED')}>
      Save {image?.name}
    </button>
  ) : null,
}))

// getBaseUrl backs the absolute-path src (/api/filesystem/file).
vi.mock('../../api/client', () => ({
  getBaseUrl: () => 'http://127.0.0.1:3456',
}))

// getServerBaseUrl backs the relative-path src (/preview-fs/<sessionId>/...).
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

import { InlineImageGallery } from './InlineImageGallery'

function imgSrcs(): string[] {
  return screen.getAllByRole('img').map((img) => (img as HTMLImageElement).getAttribute('src') ?? '')
}

describe('InlineImageGallery', () => {
  beforeEach(() => {
    queueComposerPrefill.mockReset()
  })

  it('annotates an inline image and appends the result to the session composer', () => {
    render(
      <InlineImageGallery
        text={'render saved to outputs/a/frame.png'}
        sessionId="s1"
        workDir="/w"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /frame\.png/i }))
    fireEvent.click(screen.getByRole('button', { name: /标注并提问/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save frame.png' }))

    expect(queueComposerPrefill).toHaveBeenCalledWith('s1', {
      text: '',
      mode: 'append',
      attachments: [{
        type: 'image',
        name: 'frame-annotated.png',
        data: 'data:image/png;base64,ANNOTATED',
        previewUrl: 'data:image/png;base64,ANNOTATED',
        mimeType: 'image/png',
      }],
    })
    expect(screen.queryByRole('button', { name: /标注并提问/ })).not.toBeInTheDocument()
  })

  it('suppresses host-managed ImageGen paths when their dedicated card owns the image', () => {
    render(
      <InlineImageGallery
        text={'已生成：/Users/me/.claude/cc-haha/generated-images/session/result.png'}
        suppressManagedGeneratedImages
      />,
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders an absolute image path via /api/filesystem/file (legacy behavior)', () => {
    render(<InlineImageGallery text={'see /Users/me/out/result.png done'} />)

    const srcs = imgSrcs()
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe(
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/Users/me/out/result.png'),
    )
  })

  it('ignores relative workspace images when sessionId is absent', () => {
    render(<InlineImageGallery text={'output at outputs/a/frame.png'} />)
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })

  it('renders a relative workspace image via previewFsUrl when sessionId is provided', () => {
    render(
      <InlineImageGallery
        text={'render saved to outputs/a/frame.png'}
        sessionId="s1"
        workDir="/w"
      />,
    )

    const srcs = imgSrcs()
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe('http://127.0.0.1:4321/preview-fs/s1/outputs/a/frame.png')
  })

  it('uses the absolute-file route for a changed image outside the workspace', () => {
    render(
      <InlineImageGallery
        text={'render saved to result.png'}
        sessionId="s1"
        workDir="/w"
        changedFiles={['/outside/result.png']}
      />,
    )

    expect(imgSrcs()).toEqual([
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/outside/result.png'),
    ])
  })

  it('keeps an absolute image when the turn checkpoint recorded no changes (Bash writes are untracked)', () => {
    // Regression: a PIL/Bash-generated image at /tmp is invisible to the turn
    // checkpoint (filesChanged=[]), but the gallery must not filter it away.
    render(
      <InlineImageGallery
        text={'已生成，保存到 /tmp/result.png'}
        sessionId="s1"
        workDir="/w"
        changedFiles={[]}
      />,
    )

    expect(imgSrcs()).toEqual([
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/tmp/result.png'),
    ])
  })

  it('keeps an absolute image that is not among the turn changed files', () => {
    render(
      <InlineImageGallery
        text={'已生成，保存到 /tmp/result.png，同时更新了 app.ts'}
        sessionId="s1"
        workDir="/w"
        changedFiles={['/w/src/app.ts']}
      />,
    )

    expect(imgSrcs()).toEqual([
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/tmp/result.png'),
    ])
  })

  it('treats an empty changedFiles as no evidence for relative mentions', () => {
    render(
      <InlineImageGallery
        text={'render saved to outputs/a/frame.png'}
        sessionId="s1"
        workDir="/w"
        changedFiles={[]}
      />,
    )

    expect(imgSrcs()).toEqual(['http://127.0.0.1:4321/preview-fs/s1/outputs/a/frame.png'])
  })

  it('renders a remote https image URL directly', () => {
    render(
      <InlineImageGallery
        text={'preview at https://cdn.example.com/img/result.png ok'}
        allowRemoteImages
      />,
    )

    const srcs = imgSrcs()
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe('https://cdn.example.com/img/result.png')
  })

  it('ignores remote image URLs unless allowRemoteImages is set (untrusted prose)', () => {
    render(
      <InlineImageGallery
        text={'preview at https://cdn.example.com/img/result.png ok'}
      />,
    )
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })

  it('renders a remote image URL that carries a query string, using a clean name', () => {
    render(
      <InlineImageGallery
        text={'{"previewUrl":"https://cdn.example.com/a/b.png?token=abc&x=1"}'}
        allowRemoteImages
      />,
    )

    expect(imgSrcs()).toEqual(['https://cdn.example.com/a/b.png?token=abc&x=1'])
    expect(screen.getByRole('button', { name: /b\.png/i })).toBeInTheDocument()
  })

  it('prefers the remote previewUrl over a sandboxed local absolutePath (MCP result shape)', () => {
    // Regression: an MCP image tool returns a remote previewUrl AND a local
    // absolutePath that usually 403s through the filesystem sandbox. Both render,
    // remote first — so a preview always shows even when the local path is blocked.
    render(
      <InlineImageGallery
        text={'{"previewUrl":"https://tap.example.com/x.png","absolutePath":"/Users/me/out/x.png"}'}
        allowRemoteImages
      />,
    )

    expect(imgSrcs()).toEqual([
      'https://tap.example.com/x.png',
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/Users/me/out/x.png'),
    ])
  })

  it('renders both absolute and relative images together', () => {    render(
      <InlineImageGallery
        text={'abs /Users/me/pics/photo.png and rel outputs/b/chart.png'}
        sessionId="s1"
        workDir="/w"
      />,
    )

    const srcs = imgSrcs()
    expect(srcs).toEqual([
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/Users/me/pics/photo.png'),
      'http://127.0.0.1:4321/preview-fs/s1/outputs/b/chart.png',
    ])
  })

  it('scopes image hover overlays to each image tile', () => {
    render(
      <div className="group">
        <InlineImageGallery
          text={'abs /Users/me/pics/photo.png and rel outputs/b/chart.png'}
          sessionId="s1"
          workDir="/w"
        />
      </div>,
    )

    const firstTile = screen.getByRole('button', { name: /photo\.png/i })
    expect(firstTile).toHaveClass('group/image')
    expect(firstTile).not.toHaveClass('group')

    const overlay = firstTile.querySelector('.group-hover\\/image\\:opacity-100')
    expect(overlay).not.toBeNull()
    expect(firstTile.querySelector('.group-hover\\:opacity-100')).toBeNull()
  })

  it('does not render an in-workspace absolute path twice (dedup by basename)', () => {
    // The absolute path is INSIDE workDir, so extractAssistantOutputTargets also
    // surfaces it as a relative target (frame.png). It must only render once.
    render(
      <InlineImageGallery
        text={'saved /w/outputs/a/frame.png to disk'}
        sessionId="s1"
        workDir="/w"
      />,
    )

    const srcs = imgSrcs()
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe(
      'http://127.0.0.1:3456/api/filesystem/file?path=' + encodeURIComponent('/w/outputs/a/frame.png'),
    )
  })
})
