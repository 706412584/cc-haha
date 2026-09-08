import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { parse } from 'yaml'
import { refreshWindowsUpdateMetadata } from './refresh-windows-update-metadata'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'cc-haha-signed-windows-metadata-'))
}

describe('signed Windows update metadata refresh', () => {
  test('replaces the unsigned installer checksum and size while preserving release metadata', async () => {
    const dir = tempDir()
    const installerName = 'Claude-Code-Haha-0.5.5-win-x64.exe'
    const installerPath = join(dir, installerName)
    const metadataPath = join(dir, 'latest.yml')
    const installer = Buffer.from('signed installer bytes')
    writeFileSync(installerPath, installer)
    writeFileSync(metadataPath, `
version: 0.5.5
files:
  - url: ${installerName}
    sha512: unsigned-checksum
    sha2: stale-sha256
    size: 1
path: ${installerName}
sha512: unsigned-checksum
sha2: stale-sha256
releaseDate: '2026-08-23T00:00:00.000Z'
`.trimStart())

    const result = await refreshWindowsUpdateMetadata({ installerPath, metadataPath })
    const expectedSha512 = createHash('sha512').update(installer).digest('base64')
    const metadata = parse(readFileSync(metadataPath, 'utf8')) as {
      files: Array<{ sha512: string, sha2?: string, size: number }>
      sha512: string
      sha2?: string
      releaseDate: string
    }

    expect(result).toEqual({
      installerName,
      sha512: expectedSha512,
      size: installer.length,
    })
    expect(metadata.files[0]).toMatchObject({
      sha512: expectedSha512,
      size: installer.length,
    })
    expect(metadata.files[0].sha2).toBeUndefined()
    expect(metadata.sha512).toBe(expectedSha512)
    expect(metadata.sha2).toBeUndefined()
    expect(metadata.releaseDate).toBe('2026-08-23T00:00:00.000Z')
  })

  test('rejects metadata that does not point at the signed installer', async () => {
    const dir = tempDir()
    const installerPath = join(dir, 'Claude-Code-Haha-0.5.5-win-arm64.exe')
    const metadataPath = join(dir, 'latest.yml')
    writeFileSync(installerPath, 'signed')
    writeFileSync(metadataPath, `
version: 0.5.5
files:
  - url: different-installer.exe
    sha512: old
path: different-installer.exe
sha512: old
`.trimStart())

    await expect(refreshWindowsUpdateMetadata({ installerPath, metadataPath }))
      .rejects.toThrow('Expected exactly one update file')
  })
})
