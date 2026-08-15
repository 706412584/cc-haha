import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadWorkflows } from './discovery.js'
import { getUserWorkflowsDir } from './paths.js'

function script(name: string, description: string): string {
  return `export const meta = { name: '${name}', description: '${description}' }\nreturn null\n`
}

describe('loadWorkflows', () => {
  let root: string
  let configDir: string
  let projectDir: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wf-discovery-'))
    configDir = join(root, 'config')
    projectDir = join(root, 'project')
    // Redirect the personal workflows dir away from the developer's ~/.claude.
    process.env.CLAUDE_CONFIG_DIR = configDir
    await mkdir(join(configDir, 'workflows'), { recursive: true })
    await mkdir(join(projectDir, '.claude', 'workflows'), { recursive: true })
    // getProjectDirsUpToHome stops at the git root; without one it walks to
    // home, so mark this temp dir as a repository.
    await mkdir(join(projectDir, '.git'), { recursive: true })
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await rm(root, { recursive: true, force: true })
  })

  test('resolves the personal workflows dir under CLAUDE_CONFIG_DIR', () => {
    expect(getUserWorkflowsDir()).toBe(join(configDir, 'workflows'))
  })

  test('includes bundled, personal, and project workflows', async () => {
    await writeFile(
      join(configDir, 'workflows', 'mine.js'),
      script('mine', 'Personal one'),
    )
    await writeFile(
      join(projectDir, '.claude', 'workflows', 'ours.js'),
      script('ours', 'Project one'),
    )

    const found = await loadWorkflows(projectDir)
    const byName = new Map(found.map(entry => [entry.name, entry]))
    expect(byName.get('deep-research')?.source).toBe('built-in')
    expect(byName.get('mine')?.source).toBe('userSettings')
    expect(byName.get('ours')?.source).toBe('projectSettings')
  })

  test('a project workflow shadows a personal one with the same name', async () => {
    await writeFile(
      join(configDir, 'workflows', 'review.js'),
      script('review', 'Personal review'),
    )
    await writeFile(
      join(projectDir, '.claude', 'workflows', 'review.js'),
      script('review', 'Project review'),
    )

    const found = await loadWorkflows(projectDir)
    const review = found.filter(entry => entry.name === 'review')
    expect(review).toHaveLength(1)
    expect(review[0]?.description).toBe('Project review')
    expect(review[0]?.source).toBe('projectSettings')
  })

  test('skips files that are not .js or whose meta is invalid', async () => {
    await writeFile(
      join(configDir, 'workflows', 'good.js'),
      script('good', 'Fine'),
    )
    await writeFile(
      join(configDir, 'workflows', 'broken.js'),
      'const x = 1\nexport const meta = { name: "late", description: "b" }\n',
    )
    await writeFile(
      join(configDir, 'workflows', 'ignored.ts'),
      script('ignored', 'Wrong extension'),
    )

    const names = (await loadWorkflows(projectDir)).map(entry => entry.name)
    expect(names).toContain('good')
    expect(names).not.toContain('late')
    expect(names).not.toContain('ignored')
  })

  test('a missing workflows directory is not an error', async () => {
    await rm(join(configDir, 'workflows'), { recursive: true, force: true })
    const names = (await loadWorkflows(projectDir)).map(entry => entry.name)
    expect(names).toEqual(['deep-research'])
  })
})
