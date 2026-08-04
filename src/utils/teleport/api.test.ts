import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import axios from 'axios'
import * as oauthConfig from '../../constants/oauth.js'
import * as oauthClient from '../../services/oauth/client.js'
import * as auth from '../auth.js'
import { archiveRemoteSession } from './api.js'

function mockArchiveAuth(options?: { token?: string; orgUUID?: string }) {
  const refresh = spyOn(auth, 'checkAndRefreshOAuthTokenIfNeeded').mockResolvedValue(false)
  spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue(
    options?.token === undefined
      ? undefined
      : { accessToken: options.token } as ReturnType<typeof auth.getClaudeAIOAuthTokens>,
  )
  const organization = spyOn(oauthClient, 'getOrganizationUUID')
    .mockResolvedValue(options?.orgUUID ?? null)
  spyOn(oauthConfig, 'getOauthConfig').mockReturnValue({
    BASE_API_URL: 'https://api.example.test',
  } as ReturnType<typeof oauthConfig.getOauthConfig>)
  return { refresh, organization }
}

afterEach(() => {
  mock.restore()
})

test('archives remote sessions only after a 200 or idempotent 409 response', async () => {
  mockArchiveAuth({ token: 'access-token', orgUUID: 'org-1' })
  const post = spyOn(axios, 'post')
    .mockResolvedValueOnce({ status: 200 })
    .mockResolvedValueOnce({ status: 409 })

  await archiveRemoteSession('session-1', { timeoutMs: 1_500 })
  await archiveRemoteSession('session-2', { timeoutMs: 1_500 })

  expect(post).toHaveBeenCalledTimes(2)
  expect(post.mock.calls[0]?.[0]).toBe(
    'https://api.example.test/v1/sessions/session-1/archive',
  )
  expect(post.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
    timeout: 1_500,
    headers: expect.objectContaining({
      Authorization: 'Bearer access-token',
      'x-organization-uuid': 'org-1',
    }),
  }))
})

test('rejects an archive that cannot be authenticated or confirmed', async () => {
  mockArchiveAuth({ token: 'access-token', orgUUID: 'org-1' })
  const post = spyOn(axios, 'post')
  for (const status of [401, 403, 500]) {
    post.mockResolvedValueOnce({ status })
    await expect(archiveRemoteSession(`session-${status}`)).rejects.toThrow(
      `Failed to archive remote session: HTTP ${status}`,
    )
  }

  post.mockRejectedValueOnce(new Error('request timed out'))
  await expect(archiveRemoteSession('session-timeout')).rejects.toThrow(
    'request timed out',
  )
})

test('bounds the whole archive flow when token refresh does not settle', async () => {
  const { refresh } = mockArchiveAuth({ token: 'access-token', orgUUID: 'org-1' })
  refresh.mockImplementation(
    () => new Promise<boolean>(() => {}),
  )
  const post = spyOn(axios, 'post').mockResolvedValue({ status: 200 })

  await expect(archiveRemoteSession('session-auth-timeout', { timeoutMs: 20 })).rejects.toThrow(
    'Remote session archive timed out after 20ms',
  )
  expect(post).not.toHaveBeenCalled()
})

test('bounds the whole archive flow when organization lookup does not settle', async () => {
  const { organization } = mockArchiveAuth({ token: 'access-token', orgUUID: 'org-1' })
  organization.mockImplementation(() => new Promise<string | null>(() => {}))
  const post = spyOn(axios, 'post').mockResolvedValue({ status: 200 })

  await expect(archiveRemoteSession('session-org-timeout', { timeoutMs: 20 })).rejects.toThrow(
    'Remote session archive timed out after 20ms',
  )
  expect(post).not.toHaveBeenCalled()
})

test('rejects missing credentials and unsafe remote session ids without a request', async () => {
  mockArchiveAuth({ orgUUID: 'org-1' })
  const post = spyOn(axios, 'post').mockResolvedValue({ status: 200 })

  await expect(archiveRemoteSession('session-1')).rejects.toThrow(
    'Claude Code web sessions require authentication',
  )
  await expect(archiveRemoteSession('../session-2')).rejects.toThrow(
    'Invalid remote session id',
  )
  expect(post).not.toHaveBeenCalled()
})

test('rejects a missing organization before making the archive request', async () => {
  mockArchiveAuth({ token: 'access-token' })
  const post = spyOn(axios, 'post').mockResolvedValue({ status: 200 })

  await expect(archiveRemoteSession('session-1')).rejects.toThrow(
    'Unable to get organization UUID',
  )
  expect(post).not.toHaveBeenCalled()
})
