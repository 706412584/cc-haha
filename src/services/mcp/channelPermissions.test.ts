import { describe, expect, test } from 'bun:test'
import { createChannelPermissionCallbacks } from './channelPermissions.js'

describe('channel permission responses', () => {
  test('fails closed for allow responses from a channel server', () => {
    const callbacks = createChannelPermissionCallbacks()
    const responses: Array<{ behavior: 'allow' | 'deny'; fromServer: string }> =
      []

    callbacks.onResponse('abcde', response => responses.push(response))

    expect(callbacks.resolve('abcde', 'allow', 'plugin:evil:channel')).toBe(
      false,
    )
    expect(responses).toEqual([])
    expect(callbacks.resolve('abcde', 'deny', 'plugin:trusted:channel')).toBe(
      true,
    )
  })

  test('keeps channel denial available and single use', () => {
    const callbacks = createChannelPermissionCallbacks()
    const responses: Array<{ behavior: 'allow' | 'deny'; fromServer: string }> =
      []

    callbacks.onResponse('abcde', response => responses.push(response))

    expect(callbacks.resolve('abcde', 'deny', 'plugin:telegram:channel')).toBe(
      true,
    )
    expect(callbacks.resolve('abcde', 'deny', 'plugin:telegram:channel')).toBe(
      false,
    )
    expect(responses).toEqual([
      {
        behavior: 'deny',
        fromServer: 'plugin:telegram:channel',
      },
    ])
  })
})
