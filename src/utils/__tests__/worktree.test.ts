import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { resetGitFileWatcher } from '../git/gitFilesystem.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import {
  cleanupStaleAgentWorktrees,
  createAgentWorktree,
  removeAgentWorktree,
  worktreeBranchName,
} from '../worktree.js'

let tempDir: string
let repoDir: string
let originalCwdState: string
let originalCwd: string
let originalConfigDir: string | undefined

function runGit(cwd: string, args: string[], allowFailure = false): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(stderr || stdout)
  }
  return { exitCode: result.exitCode, stdout, stderr }
}

function writeRepoFile(relativePath: string, content: string): void {
  const filePath = join(repoDir, relativePath)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content)
}

function commit(message: string): void {
  runGit(repoDir, ['add', '.'])
  runGit(repoDir, ['commit', '-m', message])
}

function commitExternalWorktreesSymlink(): string {
  const externalDir = join(tempDir, 'external-worktrees')
  mkdirSync(externalDir)
  mkdirSync(join(repoDir, '.claude'), { recursive: true })
  writeRepoFile('.claude/README.md', 'worktree configuration\n')
  symlinkSync(
    externalDir,
    join(repoDir, '.claude', 'worktrees'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  commit('add external worktrees symlink')
  runGit(repoDir, ['push', 'origin', 'main'])
  return externalDir
}

describe('createAgentWorktree', () => {
  beforeEach(() => {
    originalCwdState = getCwdState()
    originalCwd = getOriginalCwd()
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR

    tempDir = mkdtempSync(join(tmpdir(), 'cc-haha-agent-worktree-'))
    repoDir = join(tempDir, 'repo')
    const originDir = join(tempDir, 'origin.git')
    mkdirSync(repoDir, { recursive: true })

    process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude-config')
    resetSettingsCache()
    resetGitFileWatcher()

    runGit(repoDir, ['init', '-b', 'main'])
    runGit(repoDir, ['config', 'user.email', 'worktree-test@example.com'])
    runGit(repoDir, ['config', 'user.name', 'Worktree Test'])
    writeRepoFile('README.md', '# worktree test\n')
    commit('initial')

    runGit(tempDir, ['init', '--bare', originDir])
    runGit(originDir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    runGit(repoDir, ['remote', 'add', 'origin', originDir])
    runGit(repoDir, ['push', '-u', 'origin', 'main'])

    setCwdState(repoDir)
    setOriginalCwd(repoDir)
    process.chdir(repoDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    setCwdState(originalCwdState)
    setOriginalCwd(originalCwd)
    resetGitFileWatcher()
    resetSettingsCache()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('creates agent worktree branches without upstream tracking config', async () => {
    const slug = 'agent-race-proof'
    const { gitRoot, worktreeBranch, worktreePath } =
      await createAgentWorktree(slug)

    expect(worktreeBranch).toBe(worktreeBranchName(slug))

    const upstreamRemote = runGit(
      repoDir,
      ['config', '--get', `branch.${worktreeBranch}.remote`],
      true,
    )
    const upstreamMerge = runGit(
      repoDir,
      ['config', '--get', `branch.${worktreeBranch}.merge`],
      true,
    )

    expect(upstreamRemote.exitCode).not.toBe(0)
    expect(upstreamRemote.stdout.trim()).toBe('')
    expect(upstreamMerge.exitCode).not.toBe(0)
    expect(upstreamMerge.stdout.trim()).toBe('')

    expect(
      await removeAgentWorktree(worktreePath, worktreeBranch, gitRoot),
    ).toBe(true)
    expect(existsSync(worktreePath)).toBe(false)
  })

  test('refuses a repository-committed worktrees symlink before creating outside the repository', async () => {
    const externalDir = commitExternalWorktreesSymlink()

    await expect(createAgentWorktree('agent-symlink-escape')).rejects.toThrow(
      'Refusing to use unsafe worktree path',
    )

    expect(await cleanupStaleAgentWorktrees(new Date())).toBe(0)
    expect(readdirSync(externalDir)).toEqual([])
  })

  test('refuses to remove a worktree through a repository worktrees symlink', async () => {
    const externalDir = commitExternalWorktreesSymlink()
    const slug = 'agent-a1234567'
    const branch = worktreeBranchName(slug)
    const linkedWorktreePath = join(repoDir, '.claude', 'worktrees', slug)
    const externalWorktreePath = join(externalDir, slug)
    runGit(repoDir, [
      'worktree',
      'add',
      '-b',
      branch,
      linkedWorktreePath,
      'HEAD',
    ])
    writeFileSync(join(externalWorktreePath, 'keep.txt'), 'must remain\n')

    expect(
      await removeAgentWorktree(linkedWorktreePath, branch, repoDir),
    ).toBe(false)
    expect(readFileSync(join(externalWorktreePath, 'keep.txt'), 'utf8')).toBe(
      'must remain\n',
    )
  })

  test('stale cleanup skips a symlinked worktree entry and rejects non-child removal paths', async () => {
    const externalDir = join(tempDir, 'external-agent-worktree')
    const worktreesDir = join(repoDir, '.claude', 'worktrees')
    const slug = 'agent-a1234567'
    const linkedWorktreePath = join(worktreesDir, slug)
    mkdirSync(externalDir, { recursive: true })
    mkdirSync(worktreesDir, { recursive: true })
    writeFileSync(join(externalDir, 'keep.txt'), 'must remain\n')
    symlinkSync(
      externalDir,
      linkedWorktreePath,
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    expect(
      await cleanupStaleAgentWorktrees(new Date(Date.now() + 60_000)),
    ).toBe(0)
    expect(readFileSync(join(externalDir, 'keep.txt'), 'utf8')).toBe(
      'must remain\n',
    )

    expect(
      await removeAgentWorktree(
        join(repoDir, '.claude', 'not-worktrees', slug),
        worktreeBranchName(slug),
        repoDir,
      ),
    ).toBe(false)
  })
})
