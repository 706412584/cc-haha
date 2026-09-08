import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import type net from 'node:net'
import { resolveCuHelperBinary } from './cuHelperBridge.js'

const VERIFIER_TIMEOUT_MS = 5_000
const MAX_VERIFIER_OUTPUT_BYTES = 64 * 1024

export type UnixPeerIdentity = {
  pid: number
}

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  error?: string
  pid?: number
}
type PeerAttestationDeps = {
  canonicalizeExpectedPath?: (path: string) => string
  resolveVerifierBinary?: () => string | null
  runVerifier?: (
    file: string,
    args: string[],
    peerFd: number,
  ) => Promise<ExecResult>
}

function socketDescriptor(socket: net.Socket): number {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd
  if (!Number.isSafeInteger(fd) || (fd ?? -1) < 0) {
    throw new Error('cu-helper socket descriptor is unavailable')
  }
  return fd!
}

function appendBounded(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current) >= MAX_VERIFIER_OUTPUT_BYTES) return current
  const remaining = MAX_VERIFIER_OUTPUT_BYTES - Buffer.byteLength(current)
  return current + Buffer.from(chunk).subarray(0, remaining).toString()
}

/**
 * Run the signed helper as a tiny verifier process and duplicate the connected
 * daemon socket into its fd 3. The helper reads LOCAL_PEERPID/LOCAL_PEERTOKEN
 * itself, inside native Swift code, then validates the exact peer signature.
 * This deliberately avoids runtime native-call trampolines in the hardened Bun
 * sidecar: hardened runtime rejects their executable-memory transition.
 */
export async function runVerifierWithSocket(
  file: string,
  args: string[],
  peerFd: number,
  timeoutMs = VERIFIER_TIMEOUT_MS,
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe', peerFd],
    })
    child.stdout?.on('data', chunk => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr = appendBounded(stderr, chunk)
    })

    const finish = (result: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', error => {
      finish({ code: -1, stdout, stderr, error: error.message, pid: child.pid })
    })
    child.once('close', code => {
      finish({
        code: code ?? -1,
        stdout,
        stderr,
        error: timedOut ? 'daemon peer verifier timed out' : undefined,
        pid: child.pid,
      })
    })
  })
}

/**
 * Reverse-authenticate the daemon before sending it any Computer Use command.
 * A fresh signed helper receives the already-connected socket as fd 3, reads
 * the kernel peer credentials, and validates exact path, identifier, Team ID,
 * leaf certificate, and live strict signature through Security.framework.
 */
export async function attestDaemonSocketPeer(
  socket: net.Socket,
  expectedExecutablePath: string,
  deps: PeerAttestationDeps = {},
): Promise<UnixPeerIdentity | null> {
  try {
    const peerFd = socketDescriptor(socket)
    const canonicalExpectedPath = (
      deps.canonicalizeExpectedPath ?? realpathSync
    )(expectedExecutablePath)
    const verifier = (deps.resolveVerifierBinary ?? resolveCuHelperBinary)()
    if (!verifier) return null
    const runVerifier = deps.runVerifier ?? runVerifierWithSocket
    const payload = JSON.stringify({ executablePath: canonicalExpectedPath })
    const result = await runVerifier(
      verifier,
      ['attest_daemon_peer', '--payload', payload],
      peerFd,
    )
    if (result.code !== 0 || result.error) return null
    const envelope = JSON.parse(result.stdout.trim()) as {
      ok?: boolean
      result?: { trusted?: boolean; pid?: number }
    }
    const pid = envelope.result?.pid
    if (
      envelope.ok !== true
      || envelope.result?.trusted !== true
      || !Number.isSafeInteger(pid)
      || (pid ?? -1) <= 0
    ) {
      return null
    }
    return { pid: pid! }
  } catch {
    return null
  }
}
