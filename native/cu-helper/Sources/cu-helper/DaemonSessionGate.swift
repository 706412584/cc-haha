import Foundation

/// Cross-queue liveness bit set synchronously by the connection IO queue before
/// its close callback hops to the main actor. The consumer checks it on both
/// sides of `beginRequest`, closing the close-vs-dequeue scheduling race.
final class DaemonSessionToken: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true

    var isValid: Bool {
        lock.lock()
        defer { lock.unlock() }
        return valid
    }

    func invalidate() {
        lock.lock()
        valid = false
        lock.unlock()
    }
}

/// Pure lifecycle state machine for the daemon's single-client protocol.
///
/// A generation binds every queued request and close callback to the connection
/// that produced it. Replacing an idle connection invalidates its queued work;
/// replacing an in-flight connection is rejected until that request finishes.
struct DaemonSessionGate {
    enum AcceptDecision: Equatable {
        case accept(generation: UInt64, cleanupSuperseded: Bool)
        case rejectBusy
    }

    enum CleanupDecision: Equatable {
        case none
        case deferCleanup
        /// The active peer genuinely disconnected and no request can still
        /// touch session state. The daemon must clean up and terminate.
        case terminateNow
    }

    private struct Session {
        let generation: UInt64
        var connected: Bool
        var requestInFlight: Bool
    }

    private var session: Session?
    private var nextGeneration: UInt64 = 1

    mutating func acceptConnection() -> AcceptDecision {
        if session?.requestInFlight == true {
            return .rejectBusy
        }

        let cleanupSuperseded = session != nil
        let generation = nextGeneration
        nextGeneration &+= 1
        session = Session(
            generation: generation,
            connected: true,
            requestInFlight: false
        )
        return .accept(
            generation: generation,
            cleanupSuperseded: cleanupSuperseded
        )
    }

    mutating func beginRequest(generation: UInt64) -> Bool {
        guard var current = session,
              current.generation == generation,
              current.connected,
              !current.requestInFlight else {
            return false
        }
        current.requestInFlight = true
        session = current
        return true
    }

    mutating func disconnect(generation: UInt64) -> CleanupDecision {
        guard var current = session,
              current.generation == generation else {
            return .none
        }
        current.connected = false
        if current.requestInFlight {
            session = current
            return .deferCleanup
        }
        session = nil
        return .terminateNow
    }

    mutating func finishRequest(generation: UInt64) -> CleanupDecision {
        guard var current = session,
              current.generation == generation,
              current.requestInFlight else {
            return .none
        }
        current.requestInFlight = false
        if current.connected {
            session = current
            return .none
        }
        session = nil
        return .terminateNow
    }
}
