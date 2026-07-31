import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { safeParseJSON } from '../../json.js'
import { updateSettingsForSource } from '../settings.js'

// updateSettingsForSource falls back to merging on top of the raw parsed file
// when its content is valid JSON but fails schema validation. That merge
// mutates its target in place, so the raw parse must never come from the
// shared safeParseJSON cache (same bug family as GH #1126).
describe('updateSettingsForSource raw fallback', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-raw-fallback-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('never poisons parses of byte-identical settings content (GH #1126 family)', async () => {
    const projectRoot = path.join(tmpDir, 'project')
    const settingsDir = path.join(projectRoot, '.claude')
    await fs.mkdir(settingsDir, { recursive: true })

    // Valid JSON, fails schema validation (hooks must be an object) — this is
    // exactly what routes the update through the raw-parse fallback.
    const content = JSON.stringify({ hooks: 123, env: { FOO: '1' } })
    const settingsPath = path.join(settingsDir, 'settings.json')
    await fs.writeFile(settingsPath, content)

    // Warm the shared parse cache with this exact string, as any earlier
    // settings read would.
    safeParseJSON(content, false)

    const { error } = updateSettingsForSource('projectSettings', { model: 'haiku' }, projectRoot)
    expect(error).toBeNull()

    // The merge must have landed on disk…
    const onDisk = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
    expect(onDisk.model).toBe('haiku')
    expect(onDisk.env).toEqual({ FOO: '1' })

    // …while a byte-identical file elsewhere still parses to its own content,
    // without the merged-in fields bleeding through the cache.
    const again = safeParseJSON(content, false) as Record<string, unknown>
    expect(again.model).toBeUndefined()
    expect(again).toEqual({ hooks: 123, env: { FOO: '1' } })
  })
})
