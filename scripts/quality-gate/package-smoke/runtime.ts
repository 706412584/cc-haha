#!/usr/bin/env bun

import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

type RuntimeCase = 'lsp'

type RuntimeArgs = {
  case: RuntimeCase
  artifactsDir?: string
}

export function parseRuntimeArgs(argv: string[]): RuntimeArgs {
  let selectedCase: RuntimeCase | undefined
  let artifactsDir: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--case') {
      const value = argv[++index]
      if (value !== 'lsp') throw new Error('--case must be lsp')
      selectedCase = value
    } else if (arg === '--artifacts-dir') {
      artifactsDir = argv[++index]
      if (!artifactsDir) throw new Error('--artifacts-dir requires a path')
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!selectedCase) throw new Error('--case is required')
  return { case: selectedCase, ...(artifactsDir ? { artifactsDir } : {}) }
}

export function removeNpmShimPaths(
  value: string | undefined,
  appData: string | undefined,
  delimiter = path.delimiter,
): string {
  if (!value) return ''
  const npmRoot = appData ? path.resolve(appData, 'npm').toLowerCase() : null
  return value
    .split(delimiter)
    .filter((entry) => !npmRoot || path.resolve(entry).toLowerCase() !== npmRoot)
    .join(delimiter)
}

function hostSidecarName(): string {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'claude-sidecar-x86_64-pc-windows-msvc.exe'
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'claude-sidecar-aarch64-apple-darwin'
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'claude-sidecar-x86_64-apple-darwin'
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return 'claude-sidecar-aarch64-unknown-linux-gnu'
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'claude-sidecar-x86_64-unknown-linux-gnu'
  }
  throw new Error(`Unsupported host: ${process.platform}/${process.arch}`)
}

function findFile(root: string, name: string): string | null {
  if (!fs.existsSync(root)) return null
  const entries = fs.readdirSync(root, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = path.join(root, entry.name)
    if (entry.isFile() && entry.name === name) return candidate
    if (entry.isDirectory()) {
      const nested = findFile(candidate, name)
      if (nested) return nested
    }
  }
  return null
}

export function resolveRuntimeSidecar(
  repoRoot: string,
  artifactsDir?: string,
): string {
  const name = hostSidecarName()
  const packaged = artifactsDir
    ? findFile(path.resolve(repoRoot, artifactsDir), name)
    : null
  const development = path.join(repoRoot, 'desktop', 'src-tauri', 'binaries', name)
  const candidate = packaged ?? (fs.existsSync(development) ? development : null)
  if (!candidate) {
    throw new Error(`Compiled sidecar not found: ${name}`)
  }
  return candidate
}

async function runLspCase(repoRoot: string, args: RuntimeArgs): Promise<void> {
  const tempDir = await promises.mkdtemp(path.join(os.tmpdir(), 'cc-haha-packaged-lsp-'))
  try {
    const packageRoot = path.join(tempDir, 'node_modules', 'deterministic-lsp-smoke')
    const entry = path.join(packageRoot, 'bin', 'server.mjs')
    const outputPath = path.join(tempDir, 'result.json')
    await promises.mkdir(path.dirname(entry), { recursive: true })
    await promises.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'deterministic-lsp-smoke',
      type: 'module',
      bin: { 'deterministic-lsp-smoke': 'bin/server.mjs' },
    }))
    await promises.writeFile(entry, [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.env.LSP_SMOKE_OUTPUT, JSON.stringify({ argv: process.argv.slice(2), execPath: process.execPath }))",
      "let buffer = Buffer.alloc(0)",
      "const send = (message) => { const body = JSON.stringify(message); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n${body}`) }",
      "const handle = (message) => {",
      "  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1 } } })",
      "  else if (message.method === 'initialized') send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///smoke.ts', diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'deterministic smoke diagnostic', source: 'smoke' }] } })",
      "  else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null })",
      "  else if (message.method === 'exit') process.exit(0)",
      "}",
      "process.stdin.on('data', (chunk) => {",
      "  buffer = Buffer.concat([buffer, chunk])",
      "  while (true) {",
      "    const headerEnd = buffer.indexOf('\\r\\n\\r\\n')",
      "    if (headerEnd < 0) return",
      "    const match = buffer.subarray(0, headerEnd).toString().match(/Content-Length:\\s*(\\d+)/i)",
      "    if (!match) process.exit(2)",
      "    const length = Number(match[1]); const bodyStart = headerEnd + 4",
      "    if (buffer.length < bodyStart + length) return",
      "    const body = buffer.subarray(bodyStart, bodyStart + length).toString(); buffer = buffer.subarray(bodyStart + length)",
      "    handle(JSON.parse(body))",
      "  }",
      "})",
    ].join('\n'))

    const sidecar = resolveRuntimeSidecar(repoRoot, args.artifactsDir)
    const env = {
      ...process.env,
      PATH: removeNpmShimPaths(process.env.PATH, process.env.APPDATA),
      LSP_SMOKE_OUTPUT: outputPath,
    }
    const child = Bun.spawn([
      sidecar,
      'lsp',
      '--package-root', packageRoot,
      '--entry', entry,
      '--',
      '--stdio',
      '--smoke',
    ], {
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    })
    const frame = (message: object) => {
      const body = JSON.stringify(message)
      return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    }
    child.stdin.write([
      frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///smoke' } }),
      frame({ jsonrpc: '2.0', method: 'initialized', params: {} }),
      frame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }),
      frame({ jsonrpc: '2.0', method: 'exit', params: null }),
    ].join(''))
    child.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(`Compiled LSP launcher exited ${exitCode}: ${stderr}`)
    }
    const payloads = [...stdout.matchAll(/Content-Length:\s*\d+\r\n\r\n({[^]*?})(?=Content-Length:|$)/g)]
      .map((match) => JSON.parse(match[1]!)) as Array<Record<string, unknown>>
    const fixtureResult = JSON.parse(await promises.readFile(outputPath, 'utf8')) as {
      argv?: unknown
      execPath?: unknown
    }
    if (JSON.stringify(fixtureResult.argv) !== JSON.stringify(['--stdio', '--smoke'])) {
      throw new Error('Compiled LSP launcher did not preserve fixture arguments')
    }
    if (fixtureResult.execPath !== sidecar) {
      throw new Error('LSP fixture was not hosted by the compiled sidecar runtime')
    }
    if (!payloads.some((payload) => payload.id === 1 && payload.result)) {
      throw new Error('Compiled LSP fixture did not initialize')
    }
    if (!payloads.some((payload) => payload.method === 'textDocument/publishDiagnostics')) {
      throw new Error('Compiled LSP fixture did not publish diagnostics')
    }
    if (!payloads.some((payload) => payload.id === 2 && payload.result === null)) {
      throw new Error('Compiled LSP fixture did not shut down cleanly')
    }

    console.log(JSON.stringify({
      passed: true,
      case: 'lsp',
      sidecar: path.basename(sidecar),
      fixturePackage: 'deterministic-lsp-smoke',
      argv: fixtureResult.argv,
      initialized: true,
      diagnosticPublished: true,
      shutdownCleanly: true,
      npmShimPathRemoved: env.PATH !== process.env.PATH,
    }, null, 2))
  } finally {
    await promises.rm(tempDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const args = parseRuntimeArgs(process.argv.slice(2))
  const repoRoot = path.resolve(import.meta.dir, '../../..')
  await runLspCase(repoRoot, args)
}
