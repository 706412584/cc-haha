import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const manifest = require('../../package.json')
const repositoryRoot = path.resolve(path.dirname(require.resolve('../../package.json')), '..')
describe('remote access packaging', () => {
  it('bundles the verified Cloudflare connector and notices in executable ASAR resources', () => {
    expect(manifest.scripts['prepare:cloudflared']).toContain('scripts/prepare-cloudflared.ts')
    expect(manifest.build.files).toContain('src-tauri/binaries/**')
    expect(manifest.build.asarUnpack).toContain('src-tauri/binaries/**')
    const sidecars = readFileSync(path.join(repositoryRoot, 'desktop/scripts/build-sidecars.ts'), 'utf8')
    expect(sidecars).toContain('await assertPreparedCloudflared({ desktopRoot, targetTriple })')
    expect(sidecars).not.toContain('await prepareCloudflared(')
    expect(manifest.scripts['electron:package:dir']).not.toContain('prepare:cloudflared')
  })

  it.each(['release-desktop.yml', 'build-desktop-dev.yml'])('%s explicitly prepares the pinned connector before building sidecars', workflow => {
    const source = parse(readFileSync(path.join(repositoryRoot, '.github', 'workflows', workflow), 'utf8'))
    const jobs = Object.values(source.jobs) as { steps?: { name?: string, run?: string, env?: Record<string, string>, 'working-directory'?: string }[] }[]
    const buildJob = jobs.find(job => job.steps?.some(step => step.name === 'Build sidecars'))
    expect(buildJob).toBeDefined()
    const steps = buildJob!.steps!
    const prepared = steps.findIndex(step => step.name === 'Prepare bundled Cloudflare connector')
    const built = steps.findIndex(step => step.name === 'Build sidecars')
    expect(prepared).toBeGreaterThan(-1)
    expect(prepared).toBeLessThan(built)
    expect(steps[prepared]).toMatchObject({ 'working-directory': 'desktop', run: 'bun run prepare:cloudflared', env: { SIDECAR_TARGET_TRIPLE: '${{ matrix.target_triple }}' } })
  })

  it('ships the ngrok provider as an optional tunnel fallback', () => {
    // fork: ngrok is kept as an optional H5 tunnel fallback alongside cloudflared
    expect(manifest.dependencies['@ngrok/ngrok']).toBeDefined()
    expect(manifest.build.asarUnpack).toContain('node_modules/@ngrok/**')
    expect(manifest.build.files).toContain('node_modules/@ngrok/**')
    expect(manifest.scripts['build:electron']).toContain('--external @ngrok/ngrok')
  })
  it.each(['release-desktop.yml', 'build-desktop-dev.yml'])('%s installs native addons for cross-architecture packages', workflow => {
    const source = parse(readFileSync(path.join(repositoryRoot, '.github', 'workflows', workflow), 'utf8'))
    const jobs = Object.values(source.jobs) as { steps?: { name?: string, run?: string, 'working-directory'?: string }[] }[]
    const desktopInstalls = jobs.flatMap(job => job.steps ?? []).filter(step => step.name === 'Install desktop dependencies')
    expect(desktopInstalls.length).toBeGreaterThan(0)
    for (const step of desktopInstalls) {
      expect(step['working-directory']).toBe('desktop')
      // Cross-architecture packages still need their other native dependencies
      // installed before packaging because npmRebuild is disabled.
      expect(step.run).toContain('--cpu="*"')
    }
  })
})
