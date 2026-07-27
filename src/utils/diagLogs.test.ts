import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { logForDiagnosticsNoPII } from './diagLogs.js'

let tmpDir: string
let originalPath: string | undefined

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-haha-diag-writer-'))
  originalPath = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = path.join(tmpDir, 'cli-diagnostics.jsonl')
})

afterEach(async () => {
  if (originalPath === undefined) delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  else process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalPath
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('logForDiagnosticsNoPII', () => {
  test.serial('creates and repairs CLI diagnostic storage with private permissions', async () => {
    if (process.platform === 'win32') return
    const previousUmask = process.umask(0o022)
    const basePath = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE!
    const activePath = `${basePath}.${process.pid}.current.jsonl`
    try {
      fs.chmodSync(tmpDir, 0o755)
      fs.writeFileSync(activePath, 'existing\n', { mode: 0o644 })

      logForDiagnosticsNoPII('info', 'private_mode_probe')

      expect((await fsp.stat(tmpDir)).mode & 0o777).toBe(0o700)
      expect((await fsp.stat(activePath)).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previousUmask)
    }
  })

  test('owns a per-process segment and rotates it without replacing a shared append target', async () => {
    const basePath = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE!
    const activePath = `${basePath}.${process.pid}.current.jsonl`
    fs.writeFileSync(activePath, 'x'.repeat(1024 * 1024))

    logForDiagnosticsNoPII('error', 'after_rotation', { code: 'ROTATED' })

    expect(fs.existsSync(basePath)).toBe(false)
    expect(fs.readFileSync(activePath, 'utf-8')).toContain('after_rotation')
    const completedSegments = (await fsp.readdir(tmpDir)).filter((name) =>
      name.startsWith(`cli-diagnostics.jsonl.${process.pid}.`) && !name.includes('.current.'),
    )
    expect(completedSegments).toHaveLength(1)
  })
})
