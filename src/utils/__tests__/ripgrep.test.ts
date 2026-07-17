import { afterEach, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  CC_HAHA_RIPGREP_PATH_ENV,
  getBundledRipgrepPath,
  getRipgrepStatus,
  isUsableBuiltinRipgrepPath,
  resetRipgrepStateForTests,
  ripgrepCommand,
} from '../ripgrep.js'

const tempFiles: string[] = []
const originalExplicitPath = process.env[CC_HAHA_RIPGREP_PATH_ENV]

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map(path => rm(path, { force: true })))
  if (originalExplicitPath === undefined) {
    delete process.env[CC_HAHA_RIPGREP_PATH_ENV]
  } else {
    process.env[CC_HAHA_RIPGREP_PATH_ENV] = originalExplicitPath
  }
  resetRipgrepStateForTests()
})

describe('isUsableBuiltinRipgrepPath', () => {
  test('rejects Bun virtual filesystem paths', () => {
    expect(
      isUsableBuiltinRipgrepPath('B:\\~BUN\\root\\vendor\\ripgrep\\x64-win32\\rg.exe'),
    ).toBe(false)
    expect(
      isUsableBuiltinRipgrepPath('/$bunfs/root/vendor/ripgrep/arm64-darwin/rg'),
    ).toBe(false)
  })

  test('rejects missing paths', () => {
    expect(
      isUsableBuiltinRipgrepPath(join(tmpdir(), 'missing-cc-haha-rg')),
    ).toBe(false)
  })

  test('accepts real filesystem paths', async () => {
    const filePath = join(tmpdir(), `cc-haha-rg-${Date.now()}`)
    await writeFile(filePath, '')
    tempFiles.push(filePath)

    expect(isUsableBuiltinRipgrepPath(filePath)).toBe(true)
  })
})

describe('packaged ripgrep resolution', () => {
  test('maps every desktop runtime to the sidecar sibling binary', () => {
    expect(getBundledRipgrepPath({
      platform: 'darwin',
      arch: 'arm64',
      execPath: '/app/claude-sidecar-aarch64-apple-darwin',
    })).toBe('/app/rg')
    expect(getBundledRipgrepPath({
      platform: 'darwin',
      arch: 'x64',
      execPath: '/app/claude-sidecar-x86_64-apple-darwin',
    })).toBe('/app/rg')
    expect(getBundledRipgrepPath({
      platform: 'win32',
      arch: 'x64',
      execPath: 'C:\\app\\claude-sidecar-x86_64-pc-windows-msvc.exe',
    })).toBe('C:\\app\\rg.exe')
    expect(getBundledRipgrepPath({
      platform: 'win32',
      arch: 'arm64',
      execPath: 'C:\\app\\claude-sidecar-aarch64-pc-windows-msvc.exe',
    })).toBe('C:\\app\\rg.exe')
    expect(getBundledRipgrepPath({
      platform: 'linux',
      arch: 'x64',
      execPath: '/app/claude-sidecar-x86_64-unknown-linux-gnu',
    })).toBe('/app/rg')
    expect(getBundledRipgrepPath({
      platform: 'linux',
      arch: 'arm64',
      execPath: '/app/claude-sidecar-aarch64-unknown-linux-gnu',
    })).toBe('/app/rg')
  })

  test('prefers an explicit packaged executable over PATH lookup', async () => {
    const filePath = join(tmpdir(), `cc-haha-explicit-rg-${Date.now()}`)
    await writeFile(filePath, '')
    tempFiles.push(filePath)
    process.env[CC_HAHA_RIPGREP_PATH_ENV] = filePath
    resetRipgrepStateForTests()

    expect(getRipgrepStatus()).toMatchObject({
      mode: 'builtin',
      path: filePath,
    })
    expect(ripgrepCommand()).toMatchObject({
      rgPath: filePath,
      rgArgs: ['--no-config'],
    })
  })
})
