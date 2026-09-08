import AppKit
import Darwin
import Foundation

/// Explicit overlay selectors use the same running-app resolver and native
/// bundle policy as actions. Candidate ordering (including whichever app is
/// frontmost) is deliberately irrelevant.
enum DaemonOverlayTargetResolver {
    nonisolated static func resolve(
        payload: JSONValue,
        candidates: [AppTargetCandidate],
        currentIdentity: (pid_t) -> AXTreeProcessIdentity?
    ) throws -> ProvenProcessTarget? {
        guard let selector = try AppTargetResolver.selector(payload: payload),
              let resolved = try AppTargetResolver.resolve(
                  selector: selector,
                  candidates: candidates
              ) else {
            return nil
        }
        return try ResolvedTargetAuthorization.authorize(
            resolved: resolved,
            currentIdentity: currentIdentity(resolved.pid)
        )
    }
}

// MARK: - Daemon
//
// Long-lived, dual-purpose engine for the Computer Use helper.
//
// The daemon owns the single main-thread CFRunLoop (via `NSApplication.run()`)
// that the animated virtual cursor requires —
// CADisplayLink / CABasicAnimation only tick while a live run loop is spinning,
// and a per-command one-shot process dies before any animation can outlive a
// single stdout write. It also holds the *virtual* cursor's logical position
// and any held mouse buttons / keys as the single in-memory source of truth so
// `cursor_position`, implicit-`from` drags and decomposed `mouse_down`/`mouse_up`
// behave correctly across commands.
//
// Transport: a private AF_UNIX SOCK_STREAM socket carrying versioned NDJSON
// (one JSON object + '\n' per request, same per response). A GUI/AppKit process leaks
// os_log / CoreGraphics chatter to stdout/stderr, which would corrupt the TS
// bridge's `JSON.parse`; the daemon therefore reserves stdout for exactly ONE
// readiness line and serves the request/response stream over the socket.
//
//   readiness : {"ready":true,"pid":<N>,"protocolVersion":"…"}\n
//   request   : {"id":"<opaque>","requestId":"<opaque>","cmd":"<verb>",…}\n
//   response  : {"id":"<opaque>","ok":true,"result":<json>}\n
//               {"id":"<opaque>","ok":false,"error":{"message":"…","code":"…"}}\n
//
// Control verbs handled in-daemon (never reach CommandRouter):
//   overlay_show -> cursor.show()  ; result true
//   turn_end     -> release all turn-owned state ; result true
//   ping         -> version/capability hello
//   shutdown     -> result true, then NSApp.terminate(nil)
// Every other cmd is forwarded to the shared CommandRouter — the exact same
// dispatcher the one-shot CLI path uses, so each command has one implementation.

@MainActor
public final class Daemon {
    private let socketPath: String
    private let cursor: VirtualCursor
    private let inputMonitor: PhysicalInputEpochMonitor
    private let router: CommandRouter
    private let displaySleepAssertion = ComputerUseDisplaySleepAssertion()

    /// Listening socket fd (AF_UNIX SOCK_STREAM). -1 until `bindAndListen`.
    private var listenFD: Int32 = -1

    /// Serial queue that owns the accept loop. Connections each get their own
    /// serial IO queue (see `Connection`), so the main actor is never blocked
    /// by socket IO.
    private let acceptQueue = DispatchQueue(label: "dev.cchaha.cu-helper.accept")

    /// The currently-served client. v1 serves a single session at a time (the
    /// file lock upstream guarantees one Node session owns CU). A new connection
    /// supersedes any previous one.
    private var connection: Connection?
    private var connectionToken: DaemonSessionToken?
    private var sessionGate = DaemonSessionGate()
    private var turnGate = DaemonTurnGate()

    /// Set once the run loop is live; guards against double `run()`.
    private var didStartRunLoop = false

    /// True between `overlay_show` and `turn_end` (CU active this turn). The
    /// cursor re-aims at the actual injection target while this holds.
    private var overlayActive = false
    private var explicitOverlayTarget: ProvenProcessTarget?

    /// Strictly-ordered request pipeline. Each `Connection` yields framed lines
    /// here from its serial IO queue (in arrival order); a single main-actor
    /// consumer drains them one at a time, so two commands can never interleave
    /// at an await point (a cursor glide, a capture) the way independent
    /// per-request Tasks could — which previously let one command resume
    /// another's continuation under a pipelining client.
    private var requestContinuation: AsyncStream<RequestItem>.Continuation?
    private var consumerTask: Task<Void, Never>?

    init(
        socketPath: String,
        inputMonitor: PhysicalInputEpochMonitor
    ) {
        self.socketPath = socketPath
        self.inputMonitor = inputMonitor
        let cursor = VirtualCursor(headless: false)
        let windowCaptureProvider: (any WindowCaptureProviding)?
        if #available(macOS 14.0, *) {
            windowCaptureProvider = WindowCaptureStreamManager()
        } else {
            windowCaptureProvider = nil
        }
        self.cursor = cursor
        self.router = CommandRouter(
            cursor: cursor,
            capabilities: Capabilities(headless: false),
            inputMonitor: inputMonitor,
            windowCaptureProvider: windowCaptureProvider
        )
    }

    // MARK: Lifecycle

    /// Boots the AppKit app as an accessory (no Dock icon, never steals focus,
    /// but CAN own borderless overlay windows), preloads the warm-but-hidden
    /// overlay windows, binds the socket + starts accepting on a background
    /// queue, emits the single readiness line, then enters `app.run()` which
    /// never returns.
    public func run() -> Never {
        precondition(!didStartRunLoop, "Daemon.run() called twice")
        didStartRunLoop = true

        // A dead/closed client must never take the daemon down with SIGPIPE;
        // we detect short writes via EPIPE return codes instead.
        signal(SIGPIPE, SIG_IGN)

        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        // Create the overlay windows up front and keep them warm (hidden).
        // Constructing NSWindows requires the main run loop's machinery to be
        // available, which it is by the time we're here.
        cursor.preload()

        installSignalHandlers()
        installScreenParameterObserver()

        do {
            try bindAndListen()
        } catch {
            // Binding failed (socket dir missing, path in use by a live daemon,
            // perms). Surface a machine-readable line on stdout so the bridge's
            // readiness await fails fast rather than hanging, then exit cleanly.
            let payload = DaemonResponse(
                id: nil,
                ok: false,
                result: nil,
                error: errBody(from: error)
            )
            writeLineToStdout(encodeResponse(payload))
            exit(1)
        }

        // Publish our real pid so the LaunchServices-launching bridge can find
        // us: it sees only the short-lived `open`, not this launchd-reparented
        // daemon, so `proc.kill` can't reach us — it reads this pidfile instead.
        writePidfile()

        startRequestConsumer()
        startAccepting()

        // Exactly one readiness line. Harmless legacy: the bridge now senses
        // readiness by the socket coming up (LaunchServices detaches our stdout),
        // but we still emit it for the bare-exec/test paths.
        emitReadiness()

        app.run()

        // app.run() only returns on terminate; make the type checker happy and
        // guarantee teardown ran.
        teardown()
        exit(0)
    }

    private func emitReadiness() {
        let line = "{\"ready\":true,\"pid\":\(getpid()),\"proto\":1}\n"
        writeLineToStdout(Data(line.utf8))
    }

    /// Path of the pidfile we publish next to the socket (`<socket>.pid`).
    private var pidfilePath: String { socketPath + ".pid" }

    /// Write our pid to `<socket>.pid` so the LaunchServices-launching bridge —
    /// which sees only the short-lived `open`, not this launchd-reparented
    /// process — can force-terminate us on teardown. Best-effort.
    private func writePidfile() {
        try? Data("\(getpid())".utf8).write(
            to: URL(fileURLWithPath: pidfilePath), options: .atomic
        )
    }

    /// Best-effort teardown: release held inputs, hide overlays, close + unlink
    /// the socket. Safe to call more than once.
    private func teardown() {
        connectionToken?.invalidate()
        connectionToken = nil
        connection?.close()
        connection = nil

        if listenFD >= 0 {
            Darwin.close(listenFD)
            listenFD = -1
        }
        unlink(socketPath)
        unlink(pidfilePath)

        stopOverlaySession()

        // Release any keys/buttons the daemon was holding, SYNCHRONOUSLY, so we
        // never strand a stuck modifier/button when teardown is followed
        // immediately by exit() (shutdown verb + signal handlers).
        Injection.releaseAllHeldSync()
        router.invalidateWindowCaptureStream()
        router.resetSessionState()
        displaySleepAssertion.release()
        inputMonitor.stop()
    }

    // MARK: Socket setup

    private func bindAndListen() throws {
        // Remove a stale socket file if a previous daemon exited uncleanly.
        // (Binding onto an existing path returns EADDRINUSE even if nothing is
        // listening.)
        unlink(socketPath)

        // sun_path is a fixed 104-byte buffer on Darwin.
        let maxPathLen = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
        let pathBytes = Array(socketPath.utf8)
        guard pathBytes.count < maxPathLen else {
            throw CUError("bad_payload", "socket path too long for AF_UNIX (\(pathBytes.count) >= \(maxPathLen)): \(socketPath)")
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw CUError("event_alloc", "socket() failed: \(errnoString())")
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        // Copy the path into the fixed C array via a typed pointer.
        withUnsafeMutablePointer(to: &addr.sun_path) { raw in
            raw.withMemoryRebound(to: CChar.self, capacity: maxPathLen) { dst in
                for (i, byte) in pathBytes.enumerated() {
                    dst[i] = CChar(bitPattern: byte)
                }
                dst[pathBytes.count] = 0
            }
        }

        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, addrLen)
            }
        }
        guard bindResult == 0 else {
            let msg = errnoString()
            Darwin.close(fd)
            throw CUError("event_alloc", "bind(\(socketPath)) failed: \(msg)")
        }

        // Owner-only access to the control socket.
        chmod(socketPath, 0o600)

        guard Darwin.listen(fd, 4) == 0 else {
            let msg = errnoString()
            Darwin.close(fd)
            unlink(socketPath)
            throw CUError("event_alloc", "listen() failed: \(msg)")
        }

        listenFD = fd
    }

    /// Single ordered consumer of the request pipeline. Runs on the main actor
    /// for the daemon's whole life and processes one request fully before the
    /// next, so cursor-glide / capture awaits never interleave across commands.
    private func startRequestConsumer() {
        let (stream, continuation) = AsyncStream<RequestItem>.makeStream()
        requestContinuation = continuation
        consumerTask = Task { @MainActor [weak self] in
            for await item in stream {
                guard let self else { break }
                guard item.token.isValid else { continue }
                guard self.sessionGate.beginRequest(
                    generation: item.generation
                ) else {
                    continue
                }
                guard item.token.isValid else {
                    if self.sessionGate.finishRequest(
                        generation: item.generation
                    ) == .terminateNow {
                        self.terminateDisconnectedDaemon()
                    }
                    continue
                }
                await self.dispatch(line: item.line, on: item.conn)
                if self.sessionGate.finishRequest(
                    generation: item.generation
                ) == .terminateNow {
                    self.terminateDisconnectedDaemon()
                }
            }
        }
    }

    private func startAccepting() {
        let fd = listenFD
        // Weak self so the accept loop can't keep the daemon alive past
        // teardown; the loop exits when the fd is closed (accept -> EBADF).
        acceptQueue.async { [weak self] in
            while true {
                let clientFD = accept(fd, nil, nil)
                if clientFD < 0 {
                    let err = errno
                    if err == EINTR { continue }
                    // EBADF/EINVAL => listening socket closed during teardown.
                    return
                }
                guard let self else {
                    Darwin.close(clientFD)
                    return
                }
                Task { @MainActor in
                    self.handleNewConnection(fd: clientFD)
                }
            }
        }
    }

    private func handleNewConnection(fd: Int32) {
        // Authenticate the kernel-reported peer BEFORE touching generation /
        // supersession state. An untrusted local process can connect to the
        // owner-only socket path, but it can neither evict a trusted client nor
        // cause held-input/session cleanup side effects.
        guard HelperRuntimeAuthorization.authorizeDaemonConnection(fd: fd) else {
            Darwin.close(fd)
            return
        }

        let generation: UInt64
        let cleanupSuperseded: Bool
        switch sessionGate.acceptConnection() {
        case .rejectBusy:
            // The old client may have disconnected, but its request still owns
            // held-input cleanup until it completes. The caller can retry once
            // that bounded in-flight request has drained.
            Darwin.close(fd)
            return
        case let .accept(acceptedGeneration, shouldCleanup):
            generation = acceptedGeneration
            cleanupSuperseded = shouldCleanup
        }

        // A fresh connection can supersede only an idle prior generation.
        // Closing it after advancing the gate makes its queued requests and
        // eventual close callback stale by construction.
        if let existing = connection {
            connectionToken?.invalidate()
            existing.close()
            connection = nil
            connectionToken = nil
        }
        if cleanupSuperseded {
            cleanupDisconnectedSession()
        }

        let conn = Connection(fd: fd)
        let token = DaemonSessionToken()
        connection = conn
        connectionToken = token

        // Dispatch each fully-framed line to the main actor; the closure is the
        // ONLY thing that crosses the isolation boundary, and `Request`/`String`
        // are Sendable.
        // Yield framed lines into the ordered pipeline (FIFO, single consumer)
        // rather than spawning an independent Task per line. `continuation` is a
        // Sendable value captured by value, so this is isolation-clean and
        // preserves arrival order from the connection's serial IO queue.
        let continuation = requestContinuation
        conn.start(
            onRequest: { rawLine in
                continuation?.yield(RequestItem(
                    line: rawLine,
                    conn: conn,
                    generation: generation,
                    token: token
                ))
            },
            onClose: { [weak self] in
                token.invalidate()
                Task { @MainActor in
                    guard let self else { return }
                    self.handleConnectionClosed(
                        conn,
                        generation: generation,
                        token: token
                    )
                }
            }
        )
    }

    private func handleConnectionClosed(
        _ conn: Connection,
        generation: UInt64,
        token: DaemonSessionToken
    ) {
        if connection === conn {
            connection = nil
            if connectionToken === token {
                connectionToken = nil
            }
        }
        switch sessionGate.disconnect(generation: generation) {
        case .terminateNow:
            terminateDisconnectedDaemon()
        case .deferCleanup, .none:
            break
        }
    }

    /// Park all session-owned state only when the generation gate says no
    /// request can still touch it.
    private func cleanupDisconnectedSession() {
        stopOverlaySession()
        Injection.releaseAllHeldSync()
        router.invalidateWindowCaptureStream()
        router.resetSessionState()
        turnGate.reset()
        displaySleepAssertion.release()
    }

    /// A LaunchServices child is reparented to launchd, so the peer socket is
    /// the ownership signal. Once the active peer is gone and its in-flight
    /// request has drained, tear down the listener (unlinking socket + pidfile)
    /// and terminate. Superseded connections never reach this path because the
    /// generation gate treats their callbacks as stale.
    private func terminateDisconnectedDaemon() {
        teardown()
        DispatchQueue.main.async {
            NSApp.terminate(nil)
        }
    }

    // MARK: Request dispatch

    /// Frames are already split on '\n' by `Connection`. Decode, route, reply.
    /// A malformed line yields a best-effort error response with a nil id (we
    /// can't recover the id we never parsed).
    private func dispatch(line: Data, on conn: Connection) async {
        // Ignore blank keep-alive newlines.
        if line.isEmpty { return }

        let request: Request
        do {
            request = try JSONDecoder().decode(Request.self, from: line)
        } catch {
            let resp = DaemonResponse(
                id: nil,
                ok: false,
                result: nil,
                error: Envelope.ErrBody(
                    message: "invalid request JSON: \(error.localizedDescription)",
                    code: "bad_command"
                )
            )
            conn.send(encodeResponse(resp))
            return
        }

        let id = request.id
        let payload = request.payload ?? .object([:])

        do {
            let metadata = try ComputerUseDaemonProtocol.validate(request)
            let opensTurn = ComputerUseDaemonProtocol.isTurnScoped(command: request.cmd)
                && turnGate.active == nil
            try turnGate.admit(metadata, command: request.cmd)
            if opensTurn { displaySleepAssertion.acquire() }
            let result = try await route(cmd: request.cmd, payload: payload)
            if request.cmd == "turn_end" || request.cmd == "overlay_hide" {
                try turnGate.finish(metadata)
                displaySleepAssertion.release()
            }
            conn.send(encodeResponse(DaemonResponse(id: id, ok: true, result: result, error: nil)))
        } catch let cuError as CUError {
            conn.send(encodeResponse(DaemonResponse(
                id: id, ok: false, result: nil,
                error: Envelope.ErrBody(message: cuError.message, code: cuError.code)
            )))
        } catch {
            conn.send(encodeResponse(DaemonResponse(
                id: id, ok: false, result: nil,
                error: Envelope.ErrBody(message: error.localizedDescription, code: nil)
            )))
        }
    }

    /// Control verbs short-circuit here; everything else flows through the
    /// shared CommandRouter.
    private func route(cmd: String, payload: JSONValue) async throws -> JSONValue {
        guard HelperClientPolicy.isDaemonCommandAllowed(cmd) else {
            throw CUError(
                "bad_command",
                "Command is not available through the Computer Use daemon"
            )
        }
        switch cmd {
        case "overlay_show":
            try showOverlay(payload: payload)
            return .bool(true)

        case "overlay_hide", "turn_end":
            endTurn()
            return .bool(true)

        case "ping":
            return ComputerUseDaemonProtocol.hello()

        case "check_permissions":
            // Usable in both modes; the daemon exposes it for onboarding /
            // liveness probing alongside `ping`.
            return Permissions.snapshot()

        case "shutdown":
            // Reply true FIRST (caller awaits the response), then tear down on
            // the next run-loop turn so the framed response actually flushes
            // before the process exits.
            scheduleShutdown()
            return .bool(true)

        default:
            // Re-aim the cursor at the app the injection resolved as its target
            // — even if the injection itself THREW (e.g. `not_trusted` before
            // the user has granted Accessibility). `Injection.resolveTargetPid`
            // sets `lastResolvedTargetPid` BEFORE `ensurePostable` can throw, so
            // this `defer` re-aims whether the command succeeded or failed.
            // Without it, a thrown injection skipped the re-aim and stranded the
            // cursor on the initial overlay_show target forever.
            defer { retargetCursorIfNeeded() }
            return try await router.handle(cmd: cmd, payload: payload)
        }
    }

    // MARK: Control-verb helpers

    /// Reveals the virtual cursor over the app Claude is driving. The target
    /// selector is `{pid}` / `{bundleId}` / `{app}` and is resolved
    /// independently of the frontmost app.
    private func showOverlay(payload: JSONValue) throws {
        overlayActive = true
        // A new explicit request must never inherit the previous command's
        // resolved process if selector resolution fails or the app is not yet
        // running.
        Injection.clearResolvedTarget()
        explicitOverlayTarget = nil
        do {
            explicitOverlayTarget = try DaemonOverlayTargetResolver.resolve(
                payload: payload,
                candidates: AppTargetResolver.candidates(),
                currentIdentity: { AXTree.currentProcessIdentity(pid: $0) }
            )
        } catch {
            // A failed retarget must not leave the cursor bound to the prior
            // app while the caller sees an overlay_show error.
            stopOverlaySession()
            throw error
        }
        // A named app may not be running until get_app_state launches it. Stay
        // hidden rather than framing frontmost; the command's defer below will
        // re-aim as soon as the real process is resolved.
        cursor.setVisualTarget(explicitOverlayTarget)
        cursor.show()
    }

    /// Bind the cursor to whatever the most recent injection actually resolved,
    /// so it animates over the app Claude is driving rather than the one named
    /// when the turn began.
    private func retargetCursorIfNeeded() {
        guard overlayActive else { return }
        guard let target = resolvedInjectionOverlayTarget() else {
            cursor.setVisualTarget(nil)
            return
        }
        explicitOverlayTarget = target
        cursor.setVisualTarget(target)
    }

    private func stopOverlaySession() {
        overlayActive = false
        explicitOverlayTarget = nil
        Injection.clearResolvedTarget()
        cursor.hide()
    }

    /// Codex-parity turn boundary. The helper process and its SCStream consumer
    /// stay warm, while AX snapshots, coordinate transforms, focus belief,
    /// held input, mutation clocks, and clipboard diagnostics are reset. The
    /// stream key itself proves process/window/config identity and retires on
    /// any target change, screen reconfiguration, disconnect, or shutdown.
    private func endTurn() {
        stopOverlaySession()
        Injection.releaseAllHeldSync()
        router.resetSessionState()
    }

    /// The app the cursor should follow: ONLY the app the last injection /
    /// get_app_state actually resolved (`Injection.lastResolvedTargetPid`). We
    /// deliberately do NOT fall back to the frontmost app — at turn start,
    /// before any real target is resolved, the frontmost app is the HOST
    /// (Claude Code Haha), so the fallback made the cursor glide onto our own
    /// sidebar. nil here => follow nothing until a real target lands;
    /// `retargetCursorIfNeeded()` re-aims the moment one resolves.
    private func resolvedInjectionOverlayTarget() -> ProvenProcessTarget? {
        guard let target = Injection.lastResolvedTarget,
              target.pid != getpid(),
              target.validatedPid(
                  currentIdentity: AXTree.currentProcessIdentity(pid: target.pid)
              ) != nil else {
            Injection.clearResolvedTarget()
            return nil
        }
        return target
    }

    private func scheduleShutdown() {
        // The `shutdown` response was just enqueued on the connection's serial
        // IO queue. Trail a flush on that same queue so we only terminate AFTER
        // the response bytes have left for the wire; otherwise AppKit teardown
        // could race the socket write and the caller's await would never see
        // its `{ok:true}`.
        let conn = connection
        let finish: @Sendable () -> Void = {
            DispatchQueue.main.async {
                // teardown() also runs via the NSApp.terminate -> run()-return
                // path, but we do the visible/stateful cleanup here too so the
                // overlay is gone and inputs released before the process leaves.
                MainActor.assumeIsolated { self.teardown() }
                NSApp.terminate(nil)
            }
        }
        if let conn {
            conn.flush(then: finish)
        } else {
            finish()
        }
    }

    // MARK: Signals & screen changes

    /// SIGINT / SIGTERM => graceful teardown + exit. We use a DispatchSource so
    /// the handler body runs on a real queue (async-signal-safe), not in signal
    /// context.
    private var sigintSource: DispatchSourceSignal?
    private var sigtermSource: DispatchSourceSignal?

    private func installSignalHandlers() {
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN) // ignore default disposition; DispatchSource handles it
        }

        let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        sigint.setEventHandler { [weak self] in
            self?.teardown()
            exit(0)
        }
        sigint.resume()
        sigintSource = sigint

        let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigterm.setEventHandler { [weak self] in
            self?.teardown()
            exit(0)
        }
        sigterm.resume()
        sigtermSource = sigterm
    }

    /// When monitors are plugged/unplugged the overlay windows must re-anchor.
    /// The cursor owns its own per-screen window set; rebuilding it on
    /// reconfiguration keeps it aligned with the new NSScreen layout.
    private func installScreenParameterObserver() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.router.invalidateWindowCaptureStream()
                // Re-warm cursor windows for the new screen set.
                self.cursor.preload()
            }
        }
    }

    // MARK: Encoding / stdout helpers

    private func encodeResponse(_ resp: DaemonResponse) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = []
        if let data = try? encoder.encode(resp) {
            var framed = data
            framed.append(0x0A) // '\n'
            return framed
        }
        // Encoding the response itself failed (should be impossible for the
        // fixed shape). Emit a hand-rolled minimal error so the caller's awaiter
        // still resolves.
        let idJSON: String
        if let id = resp.id { idJSON = "\"\(id.replacingOccurrences(of: "\"", with: "\\\""))\"" }
        else { idJSON = "null" }
        let fallback = "{\"id\":\(idJSON),\"ok\":false,\"error\":{\"message\":\"response encode failed\"}}\n"
        return Data(fallback.utf8)
    }

    private func errBody(from error: Error) -> Envelope.ErrBody {
        if let cu = error as? CUError {
            return Envelope.ErrBody(message: cu.message, code: cu.code)
        }
        return Envelope.ErrBody(message: error.localizedDescription, code: nil)
    }

    /// Writes a full buffer to stdout, retrying on partial writes / EINTR. This
    /// is the only thing (besides the readiness line) that ever touches stdout.
    private func writeLineToStdout(_ data: Data) {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            let total = raw.count
            while offset < total {
                let n = Darwin.write(STDOUT_FILENO, base + offset, total - offset)
                if n > 0 {
                    offset += n
                } else if n < 0 && (errno == EINTR || errno == EAGAIN) {
                    continue
                } else {
                    break
                }
            }
        }
    }

    private func errnoString() -> String {
        String(cString: strerror(errno))
    }
}

/// One queued request: the framed JSON line plus the connection to reply on.
/// `Connection` is `@unchecked Sendable` and `Data` is `Sendable`, so this is
/// safe to hand across the isolation boundary into the main-actor consumer.
private struct RequestItem: @unchecked Sendable {
    let line: Data
    let conn: Connection
    let generation: UInt64
    let token: DaemonSessionToken
}

// MARK: - Connection
//
// One client connection. All socket IO (read framing + serialized writes)
// happens on this connection's private serial queue, so the byte buffer is only
// ever touched from one thread and needs no extra locking. Only `Sendable`
// values (`Data` line copies) ever escape to the main actor.
//
// Marked @unchecked Sendable: the mutable buffer is confined to `ioQueue`, and
// the closures are stored once before any IO begins. The fd is immutable.

private final class Connection: @unchecked Sendable {
    private let fd: Int32
    private let ioQueue: DispatchQueue
    private var readSource: DispatchSourceRead?

    /// Inbound byte accumulator, split on '\n'. Confined to `ioQueue`.
    private var inBuffer = Data()

    /// Capped to avoid unbounded growth from a malformed/never-newline client.
    /// 8 MiB comfortably exceeds the largest legitimate request (a base64
    /// screenshot travels in *responses*, not requests).
    private let maxBufferBytes = ComputerUseDaemonProtocol.maxFrameBytes

    private var onRequest: (@Sendable (Data) -> Void)?
    private var onClose: (@Sendable () -> Void)?
    private var closed = false

    init(fd: Int32) {
        self.fd = fd
        self.ioQueue = DispatchQueue(label: "dev.cchaha.cu-helper.conn.\(fd)")

        // Non-blocking so a slow/partial peer never wedges the read source.
        let flags = fcntl(fd, F_GETFL, 0)
        if flags >= 0 {
            _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        }
    }

    func start(
        onRequest: @escaping @Sendable (Data) -> Void,
        onClose: @escaping @Sendable () -> Void
    ) {
        ioQueue.async {
            self.onRequest = onRequest
            self.onClose = onClose

            let source = DispatchSource.makeReadSource(fileDescriptor: self.fd, queue: self.ioQueue)
            source.setEventHandler { [weak self] in
                self?.readAvailable()
            }
            // Capture the fd BY VALUE. When a connection is superseded the daemon
            // calls close() and drops its only strong reference, so the
            // Connection can deallocate before this async cancel handler runs — a
            // [weak self] capture would then be nil and Darwin.close(self.fd)
            // would be skipped, leaking the accepted fd until EMFILE. The fd is
            // an immutable value and the cancel handler fires exactly once.
            let fd = self.fd
            source.setCancelHandler {
                Darwin.close(fd)
            }
            self.readSource = source
            source.resume()
        }
    }

    private func readAvailable() {
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = chunk.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if n > 0 {
                inBuffer.append(contentsOf: chunk[0..<n])
                if inBuffer.count > maxBufferBytes {
                    // Protocol abuse — drop the connection rather than OOM.
                    closeInternal(notify: true)
                    return
                }
                drainLines()
                // Loop to drain the socket buffer fully; with O_NONBLOCK the
                // next read returns EAGAIN when empty.
                continue
            } else if n == 0 {
                // Orderly peer shutdown.
                closeInternal(notify: true)
                return
            } else {
                let err = errno
                if err == EAGAIN || err == EWOULDBLOCK {
                    return // drained for now; wait for the next readiness event
                }
                if err == EINTR {
                    continue
                }
                // Real error (ECONNRESET, etc.).
                closeInternal(notify: true)
                return
            }
        }
    }

    /// Split the accumulated buffer on '\n', emitting each complete line. The
    /// trailing partial (no newline yet) is retained for the next read.
    private func drainLines() {
        let newline: UInt8 = 0x0A
        while let idx = inBuffer.firstIndex(of: newline) {
            let lineRange = inBuffer.startIndex..<idx
            // Copy out so the emitted Data doesn't share the mutable buffer's
            // storage after we trim it.
            var line = Data(inBuffer[lineRange])
            // Tolerate CRLF from any line-oriented client.
            if line.last == 0x0D { line.removeLast() }
            inBuffer.removeSubrange(inBuffer.startIndex...idx)
            onRequest?(line)
        }
    }

    /// Serializes an already-framed (newline-terminated) response onto the IO
    /// queue. Partial-write and EINTR/EAGAIN safe.
    func send(_ data: Data) {
        ioQueue.async {
            guard !self.closed else { return }
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else { return }
                var offset = 0
                let total = raw.count
                while offset < total {
                    let n = Darwin.write(self.fd, base + offset, total - offset)
                    if n > 0 {
                        offset += n
                    } else if n < 0 && errno == EINTR {
                        continue
                    } else if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                        // Socket send buffer full on a non-blocking fd. Briefly
                        // wait for it to drain. This is a control channel with
                        // tiny messages, so this is exceedingly rare.
                        usleep(1000)
                        continue
                    } else {
                        // EPIPE / ECONNRESET: peer gone. Stop writing; the read
                        // side will observe the close.
                        self.closeInternal(notify: true)
                        return
                    }
                }
            }
        }
    }

    /// Public close (e.g. superseded by a newer connection). Hops onto the IO
    /// queue; does NOT fire onClose (the daemon initiated it).
    func close() {
        ioQueue.async {
            self.closeInternal(notify: false)
        }
    }

    /// Runs `then` AFTER every write enqueued so far has been flushed (the IO
    /// queue is serial, so this trails any pending `send`). Used by the daemon
    /// to terminate only once the `shutdown` response has actually gone out on
    /// the wire — otherwise AppKit teardown could race the socket write.
    func flush(then: @escaping @Sendable () -> Void) {
        ioQueue.async {
            then()
        }
    }

    private func closeInternal(notify: Bool) {
        guard !closed else { return }
        closed = true
        let cb = onClose
        onRequest = nil
        onClose = nil
        // Cancelling the source closes the fd in its cancel handler.
        readSource?.cancel()
        readSource = nil
        if notify { cb?() }
    }
}
