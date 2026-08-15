import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopUiPreferencesApi } from '../api/desktopUiPreferences'
import {
  captureProjectDisplayNameHydrationRevision,
  hydrateProjectDisplayNames,
  resetProjectDisplayName,
  resolveProjectDisplayName,
  setProjectDisplayName,
  subscribeProjectDisplayNameChanges,
  useProjectDisplayNameRevision,
} from './projectDisplayNameStore'

vi.mock('../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    updateProjectDisplayName: vi.fn(),
  },
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const updateProjectDisplayName = vi.mocked(desktopUiPreferencesApi.updateProjectDisplayName)

beforeEach(() => {
  hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
  updateProjectDisplayName.mockReset()
})

afterEach(() => {
  cleanup()
  hydrateProjectDisplayNames({}, Number.MAX_SAFE_INTEGER)
})

describe('projectDisplayNameStore', () => {
  it('resolves only the exact project key and not a normalized path variant', async () => {
    const projectKey = '/workspace/apps/../project'
    updateProjectDisplayName.mockResolvedValue({ ok: true, projectKey, displayName: 'Project alias' })

    await setProjectDisplayName(projectKey, 'Project alias')

    expect(resolveProjectDisplayName(projectKey)).toBe('Project alias')
    expect(resolveProjectDisplayName('/workspace/project')).toBeNull()
  })

  it('notifies subscribers when the resolved display name changes', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeProjectDisplayNameChanges(listener)
    updateProjectDisplayName.mockResolvedValue({
      ok: true,
      projectKey: '/workspace/project',
      displayName: 'Renamed',
    })

    await setProjectDisplayName('/workspace/project', 'Renamed')
    unsubscribe()
    await setProjectDisplayName('/workspace/project', 'Renamed again')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('publishes a revision snapshot for consumers that resolve multiple project keys', async () => {
    const { result } = renderHook(() => useProjectDisplayNameRevision())
    const initialRevision = result.current
    updateProjectDisplayName.mockResolvedValue({
      ok: true,
      projectKey: '/workspace/project',
      displayName: 'Renamed',
    })

    await act(async () => {
      await setProjectDisplayName('/workspace/project', 'Renamed')
    })

    expect(result.current).toBeGreaterThan(initialRevision)
  })

  it('optimistically updates one key and rolls back only that key after a failed save', async () => {
    const hydrationRevision = captureProjectDisplayNameHydrationRevision()
    hydrateProjectDisplayNames({
      '/workspace/one': 'One',
      '/workspace/two': 'Two',
    }, hydrationRevision)
    updateProjectDisplayName.mockRejectedValueOnce(new Error('save failed'))

    const save = setProjectDisplayName('/workspace/one', 'Renamed one')

    expect(resolveProjectDisplayName('/workspace/one')).toBe('Renamed one')
    expect(resolveProjectDisplayName('/workspace/two')).toBe('Two')
    await expect(save).rejects.toThrow('save failed')
    expect(resolveProjectDisplayName('/workspace/one')).toBe('One')
    expect(resolveProjectDisplayName('/workspace/two')).toBe('Two')
  })

  it('does not let an earlier failed mutation roll back a later mutation for the same key', async () => {
    const firstSave = createDeferred<{ ok: true; projectKey: string; displayName: string | null }>()
    const secondSave = createDeferred<{ ok: true; projectKey: string; displayName: string | null }>()
    let secondSaveStarted!: () => void
    const secondSaveStartedPromise = new Promise<void>((resolve) => {
      secondSaveStarted = resolve
    })
    updateProjectDisplayName
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => {
        secondSaveStarted()
        return secondSave.promise
      })

    const first = setProjectDisplayName('/workspace/project', 'First')
    const second = setProjectDisplayName('/workspace/project', 'Second')
    firstSave.reject(new Error('first save failed'))

    await expect(first).rejects.toThrow('first save failed')
    await secondSaveStartedPromise
    expect(resolveProjectDisplayName('/workspace/project')).toBe('Second')

    secondSave.resolve({ ok: true, projectKey: '/workspace/project', displayName: 'Second' })
    await expect(second).resolves.toBeUndefined()
    expect(resolveProjectDisplayName('/workspace/project')).toBe('Second')
  })

  it('keeps a post-request local mutation when a stale preference response hydrates', async () => {
    const hydrationRevision = captureProjectDisplayNameHydrationRevision()
    const saveResponse = createDeferred<{ ok: true; projectKey: string; displayName: string | null }>()
    updateProjectDisplayName.mockReturnValueOnce(saveResponse.promise)

    const save = setProjectDisplayName('/workspace/project', 'Local name')
    hydrateProjectDisplayNames({
      '/workspace/project': 'Stale server name',
      '/workspace/other': 'Other server name',
    }, hydrationRevision)

    expect(resolveProjectDisplayName('/workspace/project')).toBe('Local name')
    expect(resolveProjectDisplayName('/workspace/other')).toBe('Other server name')

    saveResponse.resolve({ ok: true, projectKey: '/workspace/project', displayName: 'Local name' })
    await save
  })

  it('keeps a mutation that settles after preference hydration starts', async () => {
    const projectKey = '/workspace/project'
    const saveResponse = createDeferred<{ ok: true; projectKey: string; displayName: string | null }>()
    updateProjectDisplayName.mockReturnValueOnce(saveResponse.promise)

    const save = setProjectDisplayName(projectKey, 'Local name')
    const hydrationRevision = captureProjectDisplayNameHydrationRevision()
    saveResponse.resolve({ ok: true, projectKey, displayName: 'Local name' })
    await save

    hydrateProjectDisplayNames({ [projectKey]: 'Stale server name' }, hydrationRevision)
    expect(resolveProjectDisplayName(projectKey)).toBe('Local name')

    const nextHydrationRevision = captureProjectDisplayNameHydrationRevision()
    hydrateProjectDisplayNames({ [projectKey]: 'New server name' }, nextHydrationRevision)
    expect(resolveProjectDisplayName(projectKey)).toBe('New server name')
  })

  it('resets a project display name through the shared update endpoint', async () => {
    const projectKey = '/workspace/project'
    const hydrationRevision = captureProjectDisplayNameHydrationRevision()
    hydrateProjectDisplayNames({ [projectKey]: 'Custom name' }, hydrationRevision)
    updateProjectDisplayName.mockResolvedValue({ ok: true, projectKey, displayName: null })

    const reset = resetProjectDisplayName(projectKey)

    expect(resolveProjectDisplayName(projectKey)).toBeNull()
    await expect(reset).resolves.toBeUndefined()
    expect(updateProjectDisplayName).toHaveBeenCalledWith(projectKey, null)
  })
})
