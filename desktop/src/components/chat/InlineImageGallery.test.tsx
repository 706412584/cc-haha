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

  it('renders both absolute and relative images together', () => {
    render(
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
