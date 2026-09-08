import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const [mode, socketPath] = process.argv.slice(2)

if (!socketPath || (mode !== 'launch' && mode !== 'serve')) {
  process.stderr.write('usage: launchdDaemon.mjs <launch|serve> <socket>\n')
  process.exit(2)
}

if (mode === 'launch') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', socketPath], {
    detached: true,
    stdio: 'ignore',
  })
  if (!child.pid) {
    process.stderr.write('detached daemon did not start\n')
    process.exit(1)
  }
  child.unref()
  process.stdout.write(`${child.pid}\n`)
} else {
  const pidfile = `${socketPath}.pid`
  let activeTurn
  let activeSocket
  let closing = false

  function removeEndpoints() {
    try { fs.rmSync(socketPath, { force: true }) } catch {}
    try { fs.rmSync(pidfile, { force: true }) } catch {}
  }

  function terminate() {
    if (closing) return
    closing = true
    activeSocket?.destroy()
    server.close(() => {
      removeEndpoints()
      process.exit(0)
    })
    setTimeout(() => {
      removeEndpoints()
      process.exit(0)
    }, 1_000).unref()
  }

  function reply(socket, id, body) {
    socket.write(`${JSON.stringify({ id, ...body })}\n`)
  }

  function handleRequest(socket, request) {
    const metadata = {
      sessionId: request.sessionId,
      turnId: request.turnId,
    }
    const connectionScoped = request.cmd === 'ping'
      || request.cmd === 'check_permissions'
      || request.cmd === 'shutdown'
      || request.turnId?.startsWith('connection-')

    if (!connectionScoped) {
      if (
        activeTurn
        && (activeTurn.sessionId !== metadata.sessionId || activeTurn.turnId !== metadata.turnId)
      ) {
        reply(socket, request.id, {
          ok: false,
          error: {
            code: 'turn_mismatch',
            message: 'A different Computer Use turn is still active; finish it before starting another',
          },
        })
        return
      }
      activeTurn ??= metadata
    }

    if (request.cmd === 'turn_end' || request.cmd === 'overlay_hide') {
      activeTurn = undefined
    }
    reply(socket, request.id, {
      ok: true,
      result: {
        cmd: request.cmd,
        sessionId: request.sessionId,
        turnId: request.turnId,
      },
    })
    if (request.cmd === 'shutdown') {
      setImmediate(terminate)
    }
  }

  removeEndpoints()
  const server = net.createServer(socket => {
    if (activeSocket) {
      socket.destroy()
      return
    }
    activeSocket = socket
    let buffered = ''
    socket.on('data', chunk => {
      buffered += chunk.toString()
      let newline
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (!line.trim()) continue
        handleRequest(socket, JSON.parse(line))
      }
    })
    socket.once('close', terminate)
  })
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600)
    fs.writeFileSync(pidfile, String(process.pid), { mode: 0o600 })
  })
  process.once('SIGTERM', terminate)
  process.once('SIGINT', terminate)
}
