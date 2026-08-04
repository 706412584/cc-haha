import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  parseLauncherArgs,
  parseLspLauncherArgs,
  resolveSidecarInvocation,
  validateLspEntry,
} from './launcherRouting'

describe('resolveSidecarInvocation', () => {
  it('keeps explicit sidecar modes unchanged', () => {
    expect(
      resolveSidecarInvocation(
        ['server', '--host', '127.0.0.1'],
        '/tmp/claude-sidecar',
        null,
      ),
    ).toEqual({
      mode: 'server',
      restArgs: ['--host', '127.0.0.1'],
      defaultAppRoot: null,
    })
  })

  it('defaults claude-haha invocations to cli mode', () => {
    expect(
      resolveSidecarInvocation(
        ['plugin', 'install', 'demo'],
        '/Users/demo/.local/bin/claude-haha',
        null,
      ),
    ).toEqual({
      mode: 'cli',
      restArgs: ['plugin', 'install', 'demo'],
      defaultAppRoot: '/Users/demo/.local/bin',
    })
  })
})

describe('parseLspLauncherArgs', () => {
  it('routes only an explicit entry followed by separated arguments', () => {
    expect(parseLspLauncherArgs([
      '--package-root', '/pkg', '--entry', '/pkg/bin/server.js', '--', '--stdio',
    ])).toEqual({
      packageRoot: '/pkg',
      entry: '/pkg/bin/server.js',
      args: ['--stdio'],
    })
    expect(() => parseLspLauncherArgs(['--eval', 'code'])).toThrow(/requires --package-root/)
    expect(() => parseLspLauncherArgs(['--package-root', '/pkg', '--entry', '/pkg/bin/server.js', '--stdio'])).toThrow(/requires --/)
  })
})

describe('validateLspEntry', () => {
  it('canonicalizes an entry inside its owning package', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-lsp-'))
    try {
      const entry = path.join(root, 'bin', 'server.mjs')
      await fs.mkdir(path.dirname(entry))
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
      await fs.writeFile(entry, '')
      await expect(validateLspEntry(entry, root)).resolves.toBe(await fs.realpath(entry))
      const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-lsp-other-'))
      try {
        await fs.writeFile(path.join(otherRoot, 'package.json'), JSON.stringify({ name: 'other' }))
        await expect(validateLspEntry(entry, otherRoot)).rejects.toThrow(/does not match/)
      } finally {
        await fs.rm(otherRoot, { recursive: true, force: true })
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects non-JavaScript entries and entries without a package root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-lsp-invalid-'))
    try {
      const entry = path.join(root, 'server.exe')
      await fs.writeFile(entry, '')
      await expect(validateLspEntry(entry)).rejects.toThrow(/package root/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('parseLauncherArgs', () => {
  it('falls back to the provided default app root', () => {
    expect(
      parseLauncherArgs(['plugin', 'install', 'demo'], '/Users/demo/.local/bin'),
    ).toEqual({
      appRoot: '/Users/demo/.local/bin',
      args: ['plugin', 'install', 'demo'],
    })
  })

  it('lets explicit app root override the default', () => {
    expect(
      parseLauncherArgs(
        ['--app-root', '/tmp/app', 'plugin', 'install', 'demo'],
        '/Users/demo/.local/bin',
      ),
    ).toEqual({
      appRoot: '/tmp/app',
      args: ['plugin', 'install', 'demo'],
    })
  })
})
