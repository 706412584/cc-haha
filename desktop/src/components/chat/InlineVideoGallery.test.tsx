import '@testing-library/jest-dom'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// getServerBaseUrl backs the relative-path src (/preview-fs/<sessionId>/...).
vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:4321',
}))

import { InlineVideoGallery } from './InlineVideoGallery'

function videoSrcs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('video')).map((v) => v.getAttribute('src') ?? '')
}

describe('InlineVideoGallery', () => {
  it('renders a relative workspace video via previewFsUrl when sessionId is provided', () => {
    const { container } = render(
      <InlineVideoGallery text={'render saved to outputs/demo.mp4'} sessionId="s1" workDir="/w" />,
    )

    const srcs = videoSrcs(container)
    expect(srcs).toHaveLength(1)
    expect(srcs[0]).toBe('http://127.0.0.1:4321/preview-fs/s1/outputs/demo.mp4')
  })

  it('treats an empty changedFiles as no evidence for relative mentions', () => {
    const { container } = render(
      <InlineVideoGallery
        text={'render saved to outputs/demo.mp4'}
        sessionId="s1"
        workDir="/w"
        changedFiles={[]}
      />,
    )

    expect(videoSrcs(container)).toEqual(['http://127.0.0.1:4321/preview-fs/s1/outputs/demo.mp4'])
  })

  it('uses the local-file route for a changed video outside the workspace', () => {
    const { container } = render(
      <InlineVideoGallery
        text={'render saved to demo.mp4'}
        sessionId="s1"
        workDir="/w"
        changedFiles={['/outside/demo.mp4']}
      />,
    )

    expect(videoSrcs(container)).toEqual([
      'http://127.0.0.1:4321/local-file/outside/demo.mp4',
    ])
  })

  it.each([
    ['/outside/direct.mp4', 'http://127.0.0.1:4321/local-file/outside/direct.mp4'],
    ['D:\\outside\\direct.mp4', 'http://127.0.0.1:4321/local-file/D%3A/outside/direct.mp4'],
  ])('renders a directly mentioned changed video at %s', (filePath, expectedSrc) => {
    const { container } = render(
      <InlineVideoGallery
        text={`render saved to ${filePath}`}
        sessionId="s1"
        workDir="/w"
        changedFiles={[filePath]}
      />,
    )

    expect(videoSrcs(container)).toEqual([expectedSrc])
  })

  it('renders an absolute workspace video link only once', () => {
    const { container } = render(
      <InlineVideoGallery
        text={'[clip](/w/out/demo.mp4)'}
        sessionId="s1"
        workDir="/w"
        changedFiles={['/w/out/demo.mp4']}
      />,
    )

    expect(videoSrcs(container)).toEqual([
      'http://127.0.0.1:4321/preview-fs/s1/out/demo.mp4',
    ])
  })

  it('uses preload="metadata" and never autoplays', () => {
    const { container } = render(
      <InlineVideoGallery text={'clip at outputs/demo.mp4'} sessionId="s1" workDir="/w" />,
    )

    const video = container.querySelector('video')!
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(video).not.toHaveAttribute('autoplay')
    expect(video).not.toHaveAttribute('loop')
  })

  it('renders nothing when sessionId is absent', () => {
    const { container } = render(<InlineVideoGallery text={'clip at outputs/demo.mp4'} />)
    expect(container.querySelectorAll('video')).toHaveLength(0)
  })

  it('renders nothing when there are no video paths', () => {
    const { container } = render(
      <InlineVideoGallery text={'just some text and an image outputs/a.png'} sessionId="s1" workDir="/w" />,
    )
    expect(container.querySelectorAll('video')).toHaveLength(0)
  })

  it('deduplicates a repeated video path', () => {
    const { container } = render(
      <InlineVideoGallery
        text={'see outputs/demo.mp4 and again outputs/demo.mp4'}
        sessionId="s1"
        workDir="/w"
      />,
    )
    expect(container.querySelectorAll('video')).toHaveLength(1)
  })
})
