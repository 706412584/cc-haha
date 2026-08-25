import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TargetIcon, resetTargetIconCache } from './TargetIcon'
import { getDefaultBaseUrl, setAuthToken, setBaseUrl } from '../../api/client'
import type { OpenTarget } from '../../api/openTargets'

const target: OpenTarget = {
  id: 'vscode',
  kind: 'ide',
  label: 'VS Code',
  icon: 'vscode',
  iconUrl: '/api/open-targets/icons/vscode',
  platform: 'darwin',
}

function pngResponse() {
  return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  })
}

describe('TargetIcon', () => {
  beforeEach(() => {
    resetTargetIconCache()
    let counter = 0
    vi.stubGlobal('URL', Object.assign(Object.create(URL), URL, {
      createObjectURL: vi.fn(() => `blob:icon-${(counter += 1)}`),
      revokeObjectURL: vi.fn(),
    }))
  })

  afterEach(() => {
    setBaseUrl(getDefaultBaseUrl())
    setAuthToken(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the bundle icon as a blob, never as a direct API URL', async () => {
    // An `<img src>` pointed at the endpoint is a cross-origin no-cors subresource:
    // no Authorization header, so the server answers 401 and the browser drops it.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(pngResponse())
    setBaseUrl('http://127.0.0.1:49237')
    setAuthToken('secret-token')

    render(<TargetIcon target={target} />)

    const image = await screen.findByRole('presentation', { hidden: true })
    expect(image).toHaveAttribute('src', 'blob:icon-1')
    expect(image.getAttribute('src')).not.toContain('/api/')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:49237/api/open-targets/icons/vscode')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret-token' })
  })

  it('falls back to a glyph when the icon cannot be read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }))

    const { container } = render(<TargetIcon target={target} />)

    await waitFor(() => expect(container.querySelector('svg')).toBeTruthy())
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders the fallback glyph for a target that ships no icon at all', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const { container } = render(<TargetIcon target={{ ...target, iconUrl: undefined }} />)

    expect(container.querySelector('svg')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches an icon once, however many rows show it', async () => {
    // Every menu repeats the same applications, and each miss costs a `sips` run
    // on the server — so both the hits and the misses have to be remembered.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(pngResponse())

    const first = render(<TargetIcon target={target} />)
    await waitFor(() => expect(first.container.querySelector('img')).toBeTruthy())
    first.unmount()

    const second = render(<TargetIcon target={target} />)
    await waitFor(() => expect(second.container.querySelector('img')).toBeTruthy())

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not refetch a bundle already known to have no icon', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 404 }))

    const first = render(<TargetIcon target={target} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    first.unmount()

    render(<TargetIcon target={target} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })
})
