import '@testing-library/jest-dom'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settingsStore'
import { MarkdownHtml } from './MarkdownHtml'

const fetchServerImageBlobUrl = vi.hoisted(() => vi.fn())
vi.mock('@/lib/authedImage', () => ({ fetchServerImageBlobUrl }))

beforeEach(() => {
  fetchServerImageBlobUrl.mockReset().mockRejectedValue(new Error('404'))
  useSettingsStore.setState({ locale: 'en' })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

describe('MarkdownHtml image lifecycle', () => {
  it('keeps prose without images in its original layout', () => {
    const { container } = render(<MarkdownHtml html="<p>Text</p>" />)
    expect(container.firstElementChild?.firstElementChild?.tagName).toBe('P')
  })

  it('preserves image presentation but ignores raw HTML claims to a portal slot', () => {
    const { container } = render(<MarkdownHtml html={'<p><span data-md-image="">text</span><img src="/a.png" alt="a" title="title" width="80" height="40" class="picture"></p>'} />)
    expect(container.querySelectorAll('[data-md-image]')).toHaveLength(1)
    const image = screen.getByRole('img', { name: 'a' })
    expect(image).toHaveAttribute('title', 'title')
    expect(image).toHaveAttribute('width', '80')
    expect(image).toHaveAttribute('height', '40')
    expect(image).toHaveClass('picture')
  })

  it.each([
    ['en', 'Unable to load image', 'Retry image: 图片.png', 'Retry'],
    ['zh', '无法加载图片', '重试图片：图片.png', '重试'],
    ['zh-TW', '無法載入圖片', '重試圖片：图片.png', '重試'],
    ['jp', '画像を読み込めません', '画像を再読み込み: 图片.png', '再試行'],
    ['kr', '이미지를 불러올 수 없습니다', '이미지 다시 시도: 图片.png', '다시 시도'],
  ] as const)('translates the error, retry, and accessible name in %s', async (locale, title, name, retry) => {
    useSettingsStore.setState({ locale })
    render(<MarkdownHtml html={'<p><img src="/preview-fs/s1/%E5%9B%BE%E7%89%87.png" alt="description"></p>'} />)
    fireEvent.error(screen.getByRole('img'))
    expect(await screen.findByRole('alert')).toHaveTextContent(title)
    expect(screen.getByRole('button', { name })).toHaveTextContent(retry)
  })

  it('reacts to a locale change while the failure is visible', async () => {
    render(<MarkdownHtml html={'<img src="/missing.png" alt="description">'} />)
    fireEvent.error(screen.getByRole('img'))
    await screen.findByRole('alert')
    act(() => useSettingsStore.setState({ locale: 'zh' }))
    expect(screen.getByRole('alert')).toHaveTextContent('无法加载图片')
    expect(screen.getByRole('button', { name: '重试图片：missing.png' })).toBeInTheDocument()
  })

  it('keeps the placeholder when the retry returns a body that cannot decode', async () => {
    fetchServerImageBlobUrl.mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce('blob:invalid')
    const { container } = render(<MarkdownHtml html={'<img src="/missing.png" alt="description">'} />)
    fireEvent.error(screen.getByRole('img'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: /Retry image/ }))
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'blob:invalid'))
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByRole('alert')).toHaveTextContent('missing.png')
    expect(screen.getByRole('button', { name: /Retry image/ })).toBeEnabled()
  })

  it('frees the old image copy and resets failures when the Markdown changes', async () => {
    fetchServerImageBlobUrl.mockResolvedValue('blob:old')
    const { rerender } = render(<MarkdownHtml html={'<img src="/a.png" alt="a">'} />)
    fireEvent.error(screen.getByRole('img'))
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:old'))
    fireEvent.error(screen.getByRole('img'))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    rerender(<MarkdownHtml html={'<p>new</p><img src="/b.png" alt="b">'} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', '/b.png')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old')
  })
})
