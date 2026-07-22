import { afterEach, describe, expect, test } from 'bun:test'
import {
  hasConfiguredLocalAccessToken,
  hasConfiguredPetAccessToken,
  isLocalAccessAuthorized,
  isPetAccessAuthorized,
  LOCAL_ACCESS_TOKEN_ENV,
  PET_ACCESS_TOKEN_ENV,
} from '../localAccessAuth.js'

const originalToken = process.env[LOCAL_ACCESS_TOKEN_ENV]
const originalPetToken = process.env[PET_ACCESS_TOKEN_ENV]

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]
  } else {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = originalToken
  }
  if (originalPetToken === undefined) {
    delete process.env[PET_ACCESS_TOKEN_ENV]
  } else {
    process.env[PET_ACCESS_TOKEN_ENV] = originalPetToken
  }
})

describe('localAccessAuth', () => {
  test('accepts only the configured process token', () => {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = 'desktop-secret'

    expect(hasConfiguredLocalAccessToken()).toBe(true)
    expect(isLocalAccessAuthorized(new Request('http://127.0.0.1:3456/api/status', {
      headers: { Authorization: 'Bearer desktop-secret' },
    }))).toBe(true)
    expect(isLocalAccessAuthorized(new Request('http://127.0.0.1:3456/api/status'), 'desktop-secret')).toBe(true)
    expect(isLocalAccessAuthorized(new Request('http://127.0.0.1:3456/api/status'), 'wrong')).toBe(false)
  })

  test('stays disabled when the process token is absent', () => {
    delete process.env[LOCAL_ACCESS_TOKEN_ENV]

    expect(hasConfiguredLocalAccessToken()).toBe(false)
    expect(isLocalAccessAuthorized(new Request('http://127.0.0.1:3456/api/status'), 'anything')).toBe(false)
  })

  test('keeps the pet capability independent from the desktop master token', () => {
    process.env[LOCAL_ACCESS_TOKEN_ENV] = 'desktop-secret'
    process.env[PET_ACCESS_TOKEN_ENV] = 'pet-secret'
    const request = new Request('http://127.0.0.1:3456/api/sessions', {
      headers: { Authorization: 'Bearer pet-secret' },
    })

    expect(hasConfiguredPetAccessToken()).toBe(true)
    expect(isPetAccessAuthorized(request)).toBe(true)
    expect(isLocalAccessAuthorized(request)).toBe(false)
    expect(isPetAccessAuthorized(request, 'desktop-secret')).toBe(false)
  })
})
