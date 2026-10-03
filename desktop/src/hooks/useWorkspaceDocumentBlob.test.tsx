import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ApiError } from '@/api/client'
import { sessionsApi } from '@/api/sessions'
import { resetDocumentBlobCacheForTests } from '@/lib/workspace/documentBlobCache'
import { useWorkspaceDocumentBlob } from './useWorkspaceDocumentBlob'

type Pending = {
  resolve: (blob: Blob) => void
  reject: (error: unknown) => void
  signal: AbortSignal | undefined
}

let pending: Pending[]
let getWorkspaceRaw: MockInstance<typeof sessionsApi.getWorkspaceRaw>

beforeEach(() => {
  resetDocumentBlobCacheForTests()
  pending = []
  getWorkspaceRaw = vi.spyOn(sessionsApi, 'getWorkspaceRaw').mockImplementation(
    (_sessionId, _path, signal) => new Promise<Blob>((resolve, reject) => {
      pending.push({ resolve, reject, signal })
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
  )
})

afterEach(() => {
  getWorkspaceRaw.mockRestore()
  resetDocumentBlobCacheForTests()
})

const blobNamed = (label: string) => new Blob([label])

describe('useWorkspaceDocumentBlob', () => {
  it('fetches the document once its version is known and reports it ready', async () => {
    const { result } = renderHook(() => useWorkspaceDocumentBlob('s', 'thesis.pdf', 'v1'))

    expect(result.current).toMatchObject({ blob: null, loading: true, error: null })
    const blob = blobNamed('v1')
    await act(async () => pending[0]!.resolve(blob))

    expect(result.current).toMatchObject({ blob, blobVersion: 'v1', loading: false, error: null })
    expect(getWorkspaceRaw).toHaveBeenCalledWith('s', 'thesis.pdf', expect.any(AbortSignal))
  })

  it('fetches nothing until the file metadata (its version) has loaded', () => {
    const { result } = renderHook(() => useWorkspaceDocumentBlob('s', 'thesis.pdf', undefined))

    expect(result.current).toMatchObject({ blob: null, loading: false })
    expect(getWorkspaceRaw).not.toHaveBeenCalled()
  })

  it('serves a remount of the same version from memory: no request, no loading flash', async () => {
    // The workspace mounts only the active tab, so a tab switch is a remount.
    const first = renderHook(() => useWorkspaceDocumentBlob('s', 'thesis.pdf', 'v1'))
    const blob = blobNamed('v1')
    await act(async () => pending[0]!.resolve(blob))
    first.unmount()

    const second = renderHook(() => useWorkspaceDocumentBlob('s', 'thesis.pdf', 'v1'))

    expect(second.result.current).toMatchObject({ blob, blobVersion: 'v1', loading: false })
    expect(getWorkspaceRaw).toHaveBeenCalledTimes(1)
  })

  it('keeps showing the previous bytes while a newer version loads, then swaps', async () => {
    const { result, rerender } = renderHook(
      ({ version }) => useWorkspaceDocumentBlob('s', 'thesis.pdf', version),
      { initialProps: { version: 'v1' } },
    )
    const v1 = blobNamed('v1')
    await act(async () => pending[0]!.resolve(v1))

    rerender({ version: 'v2' })

    // The agent rewrote the file: the reader keeps the old render, flagged as refreshing.
    expect(result.current).toMatchObject({ blob: v1, blobVersion: 'v1', loading: true })
    const v2 = blobNamed('v2')
    await act(async () => pending[1]!.resolve(v2))

    expect(result.current).toMatchObject({ blob: v2, blobVersion: 'v2', loading: false })
  })

  it('keeps the last good bytes when a refresh fails, and reports the status', async () => {
    const { result, rerender } = renderHook(
      ({ version }) => useWorkspaceDocumentBlob('s', 'thesis.pdf', version),
      { initialProps: { version: 'v1' } },
    )
    const v1 = blobNamed('v1')
    await act(async () => pending[0]!.resolve(v1))

    rerender({ version: 'v2' })
    await act(async () => pending[1]!.reject(new ApiError(413, { message: 'too big' })))

    expect(result.current.blob).toBe(v1)
    expect(result.current.blobVersion).toBe('v1')
    expect(result.current.loading).toBe(false)
    expect(result.current.errorStatus).toBe(413)
    expect(result.current.error).toBeTruthy()
  })

  it('reports a first-load failure with no bytes, and retry asks again', async () => {
    const { result } = renderHook(() => useWorkspaceDocumentBlob('s', 'thesis.pdf', 'v1'))
    await act(async () => pending[0]!.reject(new ApiError(404, { message: 'gone' })))

    expect(result.current).toMatchObject({ blob: null, loading: false, errorStatus: 404 })

    act(() => result.current.retry())
    const blob = blobNamed('v1')
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.resolve(blob))

    expect(result.current).toMatchObject({ blob, loading: false, error: null, errorStatus: null })
  })

  it('cancels the request when the viewer unmounts', () => {
    const { unmount } = renderHook(() => useWorkspaceDocumentBlob('s', 'thesis.pdf', 'v1'))
    expect(pending[0]!.signal!.aborted).toBe(false)

    unmount()

    expect(pending[0]!.signal!.aborted).toBe(true)
  })

  it("never offers one file's bytes for another file, not even for a render", async () => {
    // Keeping the old bytes across *versions* is deliberate; across *files* it
    // would draw a different document's pages under the new file's name.
    const { result, rerender } = renderHook(
      ({ path }) => useWorkspaceDocumentBlob('s', path, 'v1'),
      { initialProps: { path: 'a.pdf' } },
    )
    const a = blobNamed('a')
    await act(async () => pending[0]!.resolve(a))
    expect(result.current.blob).toBe(a)

    rerender({ path: 'b.pdf' })

    expect(result.current).toMatchObject({ blob: null, blobVersion: undefined, loading: true })
    const b = blobNamed('b')
    await act(async () => pending[1]!.resolve(b))
    expect(result.current).toMatchObject({ blob: b, blobVersion: 'v1', loading: false })
  })

  it('does not apply a result that arrives after the version moved on', async () => {
    const { result, rerender } = renderHook(
      ({ version }) => useWorkspaceDocumentBlob('s', 'thesis.pdf', version),
      { initialProps: { version: 'v1' } },
    )
    rerender({ version: 'v2' })
    // v1 was cancelled by the version change; a late v1 completion must not win.
    await act(async () => pending[0]!.resolve(blobNamed('late-v1')))
    const v2 = blobNamed('v2')
    await act(async () => pending[1]!.resolve(v2))

    expect(result.current.blob).toBe(v2)
    expect(result.current.blobVersion).toBe('v2')
  })
})
