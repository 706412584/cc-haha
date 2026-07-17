import { afterEach, describe, expect, test } from 'bun:test'

import { subprocessEnv } from './subprocessEnv.js'

const originalLocalAccessToken = process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
const originalScrubFlag = process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB

afterEach(() => {
  if (originalLocalAccessToken === undefined) {
    delete process.env.CC_HAHA_LOCAL_ACCESS_TOKEN
  } else {
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = originalLocalAccessToken
  }

  if (originalScrubFlag === undefined) {
    delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
  } else {
    process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = originalScrubFlag
  }
})

describe('subprocessEnv', () => {
  test('never exposes the desktop local access token to tool subprocesses', () => {
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'desktop-local-secret'
    delete process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB

    const env = subprocessEnv()

    expect(env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBeUndefined()
    expect(process.env.CC_HAHA_LOCAL_ACCESS_TOKEN).toBe('desktop-local-secret')
  })
})
