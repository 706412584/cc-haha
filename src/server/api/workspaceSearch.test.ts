import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleWorkspaceSearchRoute } from './workspaceSearch.js'

const cleanupDirs = new Set<string>()

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await fsp.rm(dir, { recursive: true, force: true })
  }
  cleanupDirs.clear()
})

describe('workspace search API', () => {
  it('finds a deeply nested Java class and returns workspace-relative paths', async () => {
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-search-test-'))
    cleanupDirs.add(workDir)
    execFileSync('git', ['init'], { cwd: workDir })
    const relativePath = 'services/mental-health-service/src/main/java/com/example/campus/mentalhealth/controller/MentalHealthTrendController.java'
    await fsp.mkdir(path.dirname(path.join(workDir, relativePath)), { recursive: true })
    await fsp.writeFile(path.join(workDir, relativePath), 'final class MentalHealthTrendController {}')

    const response = await handleWorkspaceSearchRoute(
      workDir,
      new URL('http://localhost/api/workspace/search?query=%20MentalHealthTrendController%20'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      state: 'ok',
      query: 'MentalHealthTrendController',
      truncated: false,
      entries: [{
        name: 'MentalHealthTrendController.java',
        path: relativePath,
        isDirectory: false,
      }],
    })
  })

  it('rejects missing and blank queries', async () => {
    for (const suffix of ['', '?query=%20%20']) {
      expect(handleWorkspaceSearchRoute('/tmp/workspace', new URL(`http://localhost/search${suffix}`)))
        .rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it('returns files in relevance order and reports when results are truncated', async () => {
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-search-limit-test-'))
    cleanupDirs.add(workDir)
    execFileSync('git', ['init'], { cwd: workDir })
    const matchingDirectory = path.join(workDir, 'MatchingClassDirectory')
    await fsp.mkdir(matchingDirectory, { recursive: true })
    await Promise.all(Array.from({ length: 201 }, (_, index) => {
      const fileName = `MatchingClass${String(index).padStart(3, '0')}.java`
      return fsp.writeFile(path.join(matchingDirectory, fileName), `final class MatchingClass${index} {}`)
    }))

    const response = await handleWorkspaceSearchRoute(
      workDir,
      new URL('http://localhost/api/workspace/search?query=MatchingClass'),
    )
    const body = await response.json() as {
      truncated: boolean
      entries: Array<{ path: string; isDirectory: boolean }>
    }

    expect(body.truncated).toBe(true)
    expect(body.entries).toHaveLength(200)
    expect(body.entries.every((entry) => !entry.isDirectory)).toBe(true)
    expect(body.entries[0]?.path).toBe('MatchingClassDirectory/MatchingClass000.java')
  })
})
