/**
 * Which directories the hot-reload watcher subscribes to.
 *
 * Adding the cross-client `.agents/skills` convention to discovery is only half
 * a feature if the watcher does not follow: a skill another client installs
 * mid-session would then stay invisible until restart.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getWatchablePaths } from '../skillChangeDetector.js'

let tmpHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalClaudeConfigDir: string | undefined
let originalDisableEnv: string | undefined
let originalCwd: string

beforeEach(async () => {
  tmpHome = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'skill-watch-test-')),
  )
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalDisableEnv = process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR
  originalCwd = process.cwd()

  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
  process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
  delete process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR
})

afterEach(async () => {
  process.chdir(originalCwd)
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('HOME', originalHome)
  restore('USERPROFILE', originalUserProfile)
  restore('CLAUDE_CONFIG_DIR', originalClaudeConfigDir)
  restore('CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR', originalDisableEnv)
  await fs.rm(tmpHome, { recursive: true, force: true })
})

async function makeDir(...segments: string[]): Promise<string> {
  const dir = path.join(...segments)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('skill change detector watch paths', () => {
  it('watches the user and project .agents/skills directories', async () => {
    const userAgents = await makeDir(tmpHome, '.agents', 'skills')
    const userClaude = await makeDir(tmpHome, '.claude', 'skills')
    const project = await makeDir(tmpHome, 'repo')
    const projectAgents = await makeDir(project, '.agents', 'skills')
    process.chdir(project)

    const paths = await getWatchablePaths()

    expect(paths).toContain(userAgents)
    expect(paths).toContain(userClaude)
    expect(paths).toContain(projectAgents)
  })

  it('leaves out .agents when cross-client discovery is switched off', async () => {
    const userAgents = await makeDir(tmpHome, '.agents', 'skills')
    const userClaude = await makeDir(tmpHome, '.claude', 'skills')
    process.env.CLAUDE_CODE_DISABLE_AGENT_SKILLS_DIR = '1'

    const paths = await getWatchablePaths()

    expect(paths).not.toContain(userAgents)
    expect(paths).toContain(userClaude)
  })

  it('skips an .agents root that does not exist rather than watching a missing path', async () => {
    // chokidar on a non-existent path never fires, and would mask a real
    // directory appearing later; the loader tolerates the miss instead.
    await makeDir(tmpHome, '.claude', 'skills')

    const paths = await getWatchablePaths()

    expect(paths.some(p => p.includes(`${path.sep}.agents${path.sep}`))).toBe(false)
  })
})
