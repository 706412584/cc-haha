type ErrorEmittingStream = {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

const guarded = new WeakSet<ErrorEmittingStream>()

/**
 * Keep a failed log write from taking the whole app down.
 *
 * When the app is launched from Finder or the Dock, the main process inherits
 * stdio that has no reader. Writing to it fails asynchronously with EPIPE from
 * inside the stream machinery, so a plain `console.log` cannot be defended with
 * try/catch at the call site — and with no `error` listener on the stream, Node
 * escalates it to an uncaught exception. Electron then shows the user a
 * "A JavaScript error occurred in the main process" dialog.
 *
 * This is reachable from ordinary operation: the sidecar exit handler logs a
 * line whenever a sidecar dies (`serverRuntime.ts`), so any crashed or killed
 * sidecar could surface that dialog. Guarding the single noisiest call site
 * would not help — the main process has ~25 console call sites, and every one
 * of them writes to these two streams.
 *
 * Losing a diagnostic line is an acceptable outcome; killing the user's session
 * over one never is. Real diagnostics are persisted separately through
 * `appendHostDiagnostic`, which writes to a file rather than to stdio.
 */
export function installStdioWriteFailureGuards(
  streams: ErrorEmittingStream[] = [process.stdout, process.stderr],
): number {
  let installed = 0
  for (const stream of streams) {
    if (guarded.has(stream)) continue
    stream.on('error', () => {})
    guarded.add(stream)
    installed += 1
  }
  return installed
}
