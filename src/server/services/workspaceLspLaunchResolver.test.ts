import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { resolveWorkspaceLspLaunch } from './workspaceLspLaunchResolver.js'

const roots: string[] = []
const descriptor = {
  language: 'typescript',
  label: 'TypeScript language server',
  packageName: 'typescript-language-server',
  binName: 'typescript-language-server',
  presetArgs: ['--stdio'],
  extensions: { '.ts': 'typescript' },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture(bin: string | Record<string, string>, entry = 'bin/server.js') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-resolver-'))
  roots.push(root)
  const packageRoot = path.join(root, 'node_modules', descriptor.packageName)
  await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true })
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: descriptor.packageName,
    bin,
  }))
  await fs.writeFile(path.join(packageRoot, entry), 'process.stdin.resume()')
  return { root, packageRoot, entry: path.join(packageRoot, entry) }
}

describe('resolveWorkspaceLspLaunch', () => {
  it('resolves a string package bin through the JavaScript runtime without npm on PATH', async () => {
    const item = await fixture('bin/server.js')
    await expect(resolveWorkspaceLspLaunch({
      workspaceRoot: item.root,
      descriptor,
      localRoots: [item.root],
      prefixRoots: [],
      compiled: false,
      execPath: '/runtime/node',
    })).resolves.toEqual({
      command: '/runtime/node',
      args: [await fs.realpath(item.entry), '--stdio'],
      shell: false,
      displayCommand: 'typescript-language-server',
    })
  })

  it('rejects a bin map without the exact requested name', async () => {
    const item = await fixture({ other: 'bin/server.js' })
    await expect(resolveWorkspaceLspLaunch({
      workspaceRoot: item.root,
      descriptor,
      localRoots: [item.root],
      prefixRoots: [],
    })).rejects.toMatchObject({ reason: 'prereq-missing' })
  })

  it('requires an exact map bin name and creates a compiled sidecar plan', async () => {
    const item = await fixture({ other: 'bin/server.js', [descriptor.binName]: 'bin/server.js' })
    const entry = await fs.realpath(item.entry)
    await expect(resolveWorkspaceLspLaunch({
      workspaceRoot: item.root,
      descriptor,
      localRoots: [item.root],
      prefixRoots: [],
      compiled: true,
      execPath: '/app/claude-sidecar',
    })).resolves.toEqual({
      command: '/app/claude-sidecar',
      args: ['lsp', '--package-root', await fs.realpath(item.packageRoot), '--entry', entry, '--', '--stdio'],
      shell: false,
      displayCommand: descriptor.binName,
    })
  })

  it('discovers a package below an npm prefix root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-prefix-'))
    roots.push(root)
    const packageRoot = path.join(root, 'lib', 'node_modules', descriptor.packageName)
    await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true })
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: descriptor.packageName,
      bin: 'bin/server.js',
    }))
    await fs.writeFile(path.join(packageRoot, 'bin', 'server.js'), '')
    await expect(resolveWorkspaceLspLaunch({
      workspaceRoot: root,
      descriptor,
      localRoots: [],
      prefixRoots: [root],
      compiled: false,
      execPath: '/runtime/node',
    })).resolves.toMatchObject({ command: '/runtime/node', displayCommand: descriptor.binName })
  })

  it.each([
    ['absolute', path.resolve('/outside/server.js')],
    ['traversal', '../outside.js'],
    ['non-js', 'bin/server.exe'],
  ])('rejects %s package bins', async (_name, bin) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-resolver-invalid-'))
    roots.push(root)
    const packageRoot = path.join(root, 'node_modules', descriptor.packageName)
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: descriptor.packageName, bin }))
    await expect(resolveWorkspaceLspLaunch({ workspaceRoot: root, descriptor, localRoots: [root], prefixRoots: [] }))
      .rejects.toMatchObject({ reason: 'prereq-missing' })
  })

  it('rejects a symlink or junction bin escaping the package root', async () => {
    const item = await fixture('bin/server.js')
    const outside = path.join(item.root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'server.js'), 'process.stdin.resume()')
    await fs.rm(path.dirname(item.entry), { recursive: true })
    try {
      await fs.symlink(outside, path.dirname(item.entry), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    await expect(resolveWorkspaceLspLaunch({
      workspaceRoot: item.root,
      descriptor,
      localRoots: [item.root],
      prefixRoots: [],
    })).rejects.toMatchObject({ reason: 'prereq-missing' })
  })
})
