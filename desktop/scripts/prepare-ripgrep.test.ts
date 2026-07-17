import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getBundledRipgrepName,
  getRipgrepAsset,
  getRipgrepDownloadUrl,
  prepareRipgrep,
  RIPGREP_LICENSE_FILES,
  RIPGREP_VERSION,
  stageRipgrepLicenses,
} from './prepare-ripgrep'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir =>
    rm(dir, { recursive: true, force: true })))
})

const supportedTargets = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'aarch64-pc-windows-msvc',
  'x86_64-pc-windows-msvc',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-gnu',
]

describe('prepare-ripgrep target mapping', () => {
  test('pins checksummed official assets for every desktop release target', () => {
    for (const target of supportedTargets) {
      const asset = getRipgrepAsset(target)
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(asset.archiveName).toContain(`ripgrep-${RIPGREP_VERSION}-`)
      expect(getRipgrepDownloadUrl(target)).toBe(
        `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${asset.archiveName}`,
      )
    }
  })

  test('uses a static musl archive for the x64 Linux release', () => {
    expect(getRipgrepAsset('x86_64-unknown-linux-gnu').assetTriple).toBe(
      'x86_64-unknown-linux-musl',
    )
  })

  test('stages executables beside the matching sidecar', () => {
    expect(getBundledRipgrepName('aarch64-apple-darwin')).toBe(
      'rg',
    )
    expect(getBundledRipgrepName('x86_64-pc-windows-msvc')).toBe(
      'rg.exe',
    )
  })

  test('rejects unsupported targets', () => {
    expect(() => getRipgrepAsset('armv7-unknown-linux-gnu')).toThrow(
      'Unsupported target triple',
    )
  })

  test('stages the pinned ripgrep license set for offline builds', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'cc-haha-ripgrep-licenses-'))
    tempDirs.push(fixtureDir)

    const licensesDir = await stageRipgrepLicenses(fixtureDir)

    for (const fileName of RIPGREP_LICENSE_FILES) {
      expect(await readFile(path.join(licensesDir, fileName), 'utf8')).not.toHaveLength(0)
    }
  })

  test('rejects a local archive that does not match the pinned checksum', async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'cc-haha-ripgrep-test-'))
    tempDirs.push(fixtureDir)
    const archivePath = path.join(fixtureDir, 'ripgrep.tar.gz')
    await writeFile(archivePath, 'not an official ripgrep archive')

    await expect(prepareRipgrep({
      targetTriple: 'aarch64-apple-darwin',
      archivePath,
    })).rejects.toThrow('SHA256 mismatch')
  })
})
