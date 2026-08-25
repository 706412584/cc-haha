import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultBaseUrl, setBaseUrl } from './client'
import { openTargetsApi } from './openTargets'

describe('openTargetsApi', () => {
  afterEach(() => {
    setBaseUrl(getDefaultBaseUrl())
    vi.restoreAllMocks()
  })

  it('keeps the icon path server-relative so it is fetched through the credential path', async () => {
    // Absolute URLs only existed to feed an `<img src>`, and that shape is exactly
    // what the server's fetch-metadata policy rejects: a cross-origin no-cors
    // subresource carries no Authorization header and comes back 401.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      platform: 'darwin',
      targets: [
        {
          id: 'vscode',
          kind: 'ide',
          label: 'VS Code',
          icon: 'vscode',
          iconUrl: '/api/open-targets/icons/vscode',
          platform: 'darwin',
        },
      ],
      primaryTargetId: 'vscode',
      cachedAt: 1,
      ttlMs: 30_000,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    setBaseUrl('http://127.0.0.1:49237')

    await expect(openTargetsApi.list()).resolves.toMatchObject({
      targets: [
        {
          id: 'vscode',
          iconUrl: '/api/open-targets/icons/vscode',
        },
      ],
    })
  })

  it('requests open targets for the concrete file path', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      platform: 'darwin',
      targets: [],
      primaryTargetId: null,
      cachedAt: 1,
      ttlMs: 30_000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    setBaseUrl('http://127.0.0.1:49237')
    await openTargetsApi.listForPath('/tmp/My Report.docx')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/open-targets?path=%2Ftmp%2FMy%20Report.docx',
      expect.any(Object),
    )
  })
})
