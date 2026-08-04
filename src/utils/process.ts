function handleEPIPE(
  stream: NodeJS.WriteStream,
): (err: NodeJS.ErrnoException) => void {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      settlePendingWrites(stream)
      stream.destroy()
    }
  }
}

// Prevents memory leak when pipe is broken (e.g., `claude -p | head -1`)
export function registerProcessOutputErrorHandlers(): void {
  process.stdout.on('error', handleEPIPE(process.stdout))
  process.stderr.on('error', handleEPIPE(process.stderr))
}

const MIN_OUTPUT_DRAIN_TIMEOUT_MS = 2000
const MAX_OUTPUT_DRAIN_TIMEOUT_MS = 30_000
// Give slow pipeline consumers 1s per 512 KiB, without allowing exit to hang forever.
const OUTPUT_DRAIN_BYTES_PER_SECOND = 512 * 1024

interface PendingWrite {
  done: Promise<void>
  settle: () => void
  stream: NodeJS.WriteStream
}

const pendingWrites = new Set<PendingWrite>()
const drainPromises = new WeakMap<
  NodeJS.WriteStream,
  Promise<void>
>()
let pendingOutputBytes = 0

function settlePendingWrites(stream: NodeJS.WriteStream): void {
  for (const write of [...pendingWrites]) {
    if (write.stream === stream) write.settle()
  }
}

function waitForStreamDrain(stream: NodeJS.WriteStream): Promise<void> {
  const existing = drainPromises.get(stream)
  if (existing) return existing
  const drain = new Promise<void>(resolve => {
    stream.once('drain', () => {
      drainPromises.delete(stream)
      resolve()
    })
  })
  drainPromises.set(stream, drain)
  return drain
}

function isEPIPE(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === 'EPIPE'
  )
}

function writeOut(stream: NodeJS.WriteStream, data: string): void {
  if (stream.destroyed) {
    return
  }

  const bytes = Buffer.byteLength(data)
  let settled = false
  let callbackComplete = false
  let writeResultKnown = false
  let waitingForDrain = false
  let resolveDone: (() => void) | undefined
  const done = new Promise<void>(resolve => {
    resolveDone = resolve
  })
  const settleIfComplete = () => {
    if (settled) return
    if (callbackComplete && writeResultKnown && !waitingForDrain) {
      pendingWrite.settle()
    }
  }
  const pendingWrite: PendingWrite = {
    done,
    settle: () => {
      if (settled) return
      settled = true
      pendingWrites.delete(pendingWrite)
      pendingOutputBytes = Math.max(0, pendingOutputBytes - bytes)
      resolveDone?.()
    },
    stream,
  }
  pendingWrites.add(pendingWrite)
  pendingOutputBytes += bytes

  try {
    const accepted = stream.write(data, error => {
      if (error) {
        pendingWrite.settle()
        if (isEPIPE(error)) {
          settlePendingWrites(stream)
          stream.destroy()
        }
        return
      }
      callbackComplete = true
      settleIfComplete()
    })
    if (settled) return
    writeResultKnown = true
    // Some stdout wrappers acknowledge their callback before the underlying
    // stream drains, so a false return requires both signals before exit.
    waitingForDrain = !accepted
    if (waitingForDrain) {
      void waitForStreamDrain(stream).then(() => {
        waitingForDrain = false
        settleIfComplete()
      })
    }
    settleIfComplete()
  } catch (error) {
    pendingWrite.settle()
    if (isEPIPE(error)) {
      settlePendingWrites(stream)
      stream.destroy()
      return
    }
    throw error
  }
}

export function writeToStdout(data: string): void {
  writeOut(process.stdout, data)
}

export function writeToStderr(data: string): void {
  writeOut(process.stderr, data)
}

/**
 * Return the bounded time allowed to drain output already queued by this module.
 * The budget grows with byte count so large stream-json results are not held to
 * the same timeout as a short terminal message.
 */
export function getProcessOutputDrainTimeoutMs(): number {
  if (pendingOutputBytes === 0) return 0
  const byteBudgetMs = Math.ceil(
    (pendingOutputBytes / OUTPUT_DRAIN_BYTES_PER_SECOND) * 1000,
  )
  return Math.min(
    MAX_OUTPUT_DRAIN_TIMEOUT_MS,
    MIN_OUTPUT_DRAIN_TIMEOUT_MS + byteBudgetMs,
  )
}

/** Wait until queued stdout/stderr callbacks complete, or the bounded budget expires. */
export async function flushProcessOutput(
  timeoutMs = getProcessOutputDrainTimeoutMs(),
): Promise<void> {
  if (pendingOutputBytes === 0 || timeoutMs <= 0) return

  const flushed = (async () => {
    while (pendingWrites.size > 0) {
      await Promise.all([...pendingWrites].map(write => write.done))
    }
  })()

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      flushed,
      new Promise<void>(resolve => {
        // eslint-disable-next-line no-restricted-syntax -- bounded output-drain deadline, not a sleep
        timeoutId = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

// Write error to stderr and exit with code 1. Consolidates the
// console.error + process.exit(1) pattern used in entrypoint fast-paths.
export function exitWithError(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

// Wait for a stdin-like stream to close, but give up after ms if no data ever
// arrives. First data chunk cancels the timeout — after that, wait for end
// unconditionally (caller's accumulator needs all chunks, not just the first).
// Returns true on timeout, false on end. Used by -p mode to distinguish a
// real pipe producer from an inherited-but-idle parent stdin.
export function peekForStdinData(
  stream: NodeJS.EventEmitter,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const done = (timedOut: boolean) => {
      clearTimeout(peek)
      stream.off('end', onEnd)
      stream.off('data', onFirstData)
      void resolve(timedOut)
    }
    const onEnd = () => done(false)
    const onFirstData = () => clearTimeout(peek)
    // eslint-disable-next-line no-restricted-syntax -- not a sleep: races timeout against stream end/data events
    const peek = setTimeout(done, ms, true)
    stream.once('end', onEnd)
    stream.once('data', onFirstData)
  })
}
