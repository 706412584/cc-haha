import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startMock, statusMock, logoutMock, settingsFetchAllMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  statusMock: vi.fn(),
  logoutMock: vi.fn(),
  settingsFetchAllMock: vi.fn(),
}))

vi.mock('../api/hahaOAuth', () => ({
  hahaOAuthApi: {
    start: startMock,
    status: statusMock,
    logout: logoutMock,
  },
}))

vi.mock('./settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({ fetchAll: settingsFetchAllMock }),
  },
}))

import { useHahaOAuthStore } from './hahaOAuthStore'

const initialState = useHahaOAuthStore.getState()

describe('hahaOAuthStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    startMock.mockReset()
    statusMock.mockReset()
    logoutMock.mockReset()
    settingsFetchAllMock.mockReset()
    settingsFetchAllMock.mockResolvedValue(undefined)
    useHahaOAuthStore.setState({
      ...initialState,
      status: null,
      isPolling: false,
      isLoading: false,
      error: null,
    })
  })

  afterEach(() => {
    useHahaOAuthStore.getState().stopPolling()
    useHahaOAuthStore.setState(initialState)
    vi.useRealTimers()
  })

  it('login does not start polling until the browser launch succeeds', async () => {
    startMock.mockResolvedValue({
      authorizeUrl: 'http://localhost:3456/api/haha-oauth/callback',
      state: 'state-123',
    })

    const result = await useHahaOAuthStore.getState().login()

    expect(result.authorizeUrl).toContain('/api/haha-oauth/callback')
    expect(useHahaOAuthStore.getState().isPolling).toBe(false)
  })

  it('startPolling stops after the status becomes logged in', async () => {
    statusMock
      .mockResolvedValueOnce({ loggedIn: false })
      .mockResolvedValueOnce({
        loggedIn: true,
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      })

    useHahaOAuthStore.getState().startPolling()
    expect(useHahaOAuthStore.getState().isPolling).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(useHahaOAuthStore.getState().isPolling).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(useHahaOAuthStore.getState().status).toMatchObject({
      loggedIn: true,
      subscriptionType: 'max',
    })
    expect(useHahaOAuthStore.getState().isPolling).toBe(false)
    expect(settingsFetchAllMock).toHaveBeenCalledTimes(1)
  })

  it('does not refresh model settings for a logged-out status check', async () => {
    statusMock.mockResolvedValue({ loggedIn: false })

    await useHahaOAuthStore.getState().fetchStatus()

    expect(settingsFetchAllMock).not.toHaveBeenCalled()
  })
})
