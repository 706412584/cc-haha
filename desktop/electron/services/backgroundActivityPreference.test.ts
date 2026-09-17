import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKGROUND_ACTIVITY_PREFERENCE_FILE,
  backgroundActivityPreferencePath,
  readKeepActiveInBackground,
  writeKeepActiveInBackground,
} from './backgroundActivityPreference'

describe('background activity preference persistence', () => {
  let root: string
  let app: { getPath(name: 'userData'): string }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-background-activity-'))
    app = { getPath: () => root }
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('defaults to throttling in the background when nothing is stored', () => {
    expect(readKeepActiveInBackground(app)).toBe(false)
  })

  it('round-trips an enabled preference', () => {
    writeKeepActiveInBackground(app, true)

    expect(readKeepActiveInBackground(app)).toBe(true)
    expect(JSON.parse(fs.readFileSync(backgroundActivityPreferencePath(app), 'utf8'))).toEqual({
      keepActiveInBackground: true,
    })
  })

  it('round-trips a disabled preference', () => {
    writeKeepActiveInBackground(app, true)
    writeKeepActiveInBackground(app, false)

    expect(readKeepActiveInBackground(app)).toBe(false)
  })

  it('ignores malformed, non-boolean, and extra persisted fields', () => {
    fs.writeFileSync(backgroundActivityPreferencePath(app), '{ broken')
    expect(readKeepActiveInBackground(app)).toBe(false)

    fs.writeFileSync(
      backgroundActivityPreferencePath(app),
      JSON.stringify({ keepActiveInBackground: 'yes' }),
    )
    expect(readKeepActiveInBackground(app)).toBe(false)

    fs.writeFileSync(
      backgroundActivityPreferencePath(app),
      JSON.stringify({ keepActiveInBackground: true, extra: true }),
    )
    expect(readKeepActiveInBackground(app)).toBe(false)
  })

  it('rejects a non-boolean write rather than storing a truthy value', () => {
    expect(() => writeKeepActiveInBackground(app, 'yes' as unknown as boolean)).toThrow()
    expect(readKeepActiveInBackground(app)).toBe(false)
  })

  it('stores the preference in the app-owned userData directory', () => {
    expect(backgroundActivityPreferencePath(app)).toBe(
      path.join(root, BACKGROUND_ACTIVITY_PREFERENCE_FILE),
    )
  })

  it('leaves no temporary file behind after a write', () => {
    writeKeepActiveInBackground(app, true)

    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
