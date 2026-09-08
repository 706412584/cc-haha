import { describe, expect, test } from 'bun:test'
import { buildSessionContext } from './wrapper.js'

describe('Computer Use session authorization', () => {
  test('enables every supported app without exposing a runtime permission callback', () => {
    const context = buildSessionContext()

    expect(context.getAllowedApps()).toEqual([])
    expect(context.getUserDeniedBundleIds()).toEqual([])
    expect(context.getGrantFlags()).toEqual({
      clipboardRead: true,
      clipboardWrite: true,
      systemKeyCombos: true,
    })
    expect(context.onPermissionRequest).toBeUndefined()
  })
})
