import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  parseRuntimeArgs,
  removeNpmShimPaths,
  resolveRuntimeSidecar,
} from './runtime'

describe('package runtime smoke args', () => {
  test('requires the explicit LSP case', () => {
    expect(() => parseRuntimeArgs([])).toThrow('--case is required')
    expect(() => parseRuntimeArgs(['--case', 'electron'])).toThrow('--case must be lsp')
    expect(parseRuntimeArgs(['--case', 'lsp', '--artifacts-dir', 'artifacts'])).toEqual({
      case: 'lsp',
      artifactsDir: 'artifacts',
    })
  })

  test('removes only the Windows npm shim root from PATH', () => {
    expect(removeNpmShimPaths(
      'C:\\Windows;C:\\Users\\tester\\AppData\\Roaming\\npm;C:\\Tools',
      'C:\\Users\\tester\\AppData\\Roaming',
      ';',
    )).toBe('C:\\Windows;C:\\Tools')
  })

  test('prefers a packaged sidecar over the development binary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-sidecar-resolution-'))
    try {
      const sidecarName = process.platform === 'win32'
        ? 'claude-sidecar-x86_64-pc-windows-msvc.exe'
        : process.platform === 'darwin'
          ? `claude-sidecar-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
          : `claude-sidecar-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`
      const packaged = path.join(root, 'artifacts', 'nested', sidecarName)
      const development = path.join(root, 'desktop', 'src-tauri', 'binaries', sidecarName)
      await fs.mkdir(path.dirname(packaged), { recursive: true })
      await fs.mkdir(path.dirname(development), { recursive: true })
      await fs.writeFile(packaged, '')
      await fs.writeFile(development, '')

      expect(resolveRuntimeSidecar(root, 'artifacts')).toBe(packaged)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
