import Foundation

/// Versioned request contract for the authenticated daemon socket.
///
/// Code signature attestation proves who is connected; this handshake proves
/// that both sides agree on request shape and lifecycle semantics. Every request
/// also carries an absolute deadline plus session/turn identity so a command
/// queued behind a slow capture cannot execute after its caller has moved on.
enum ComputerUseDaemonProtocol {
    static let version = "CCHahaComputerUseIPC-2"
    static let maxFrameBytes = 8 * 1024 * 1024
    private static let connectionScopedCommands: Set<String> = [
        "ping", "check_permissions", "list_installed_apps", "shutdown",
    ]

    static func isTurnScoped(command: String) -> Bool {
        !connectionScopedCommands.contains(command)
    }

    struct Metadata: Equatable, Sendable {
        let sessionId: String
        let turnId: String
    }

    static func validate(
        _ request: Request,
        nowUnixMilliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)
    ) throws -> Metadata {
        guard request.clientApiVersion == version else {
            throw CUError(
                "protocol_mismatch",
                "Computer Use client/helper protocol mismatch; restart the app after updating"
            )
        }
        guard let id = request.id, !id.isEmpty,
              request.requestId == id else {
            throw CUError("bad_request_id", "Computer Use request identity is missing or inconsistent")
        }
        guard let deadline = request.deadlineUnixMilliseconds else {
            throw CUError("missing_deadline", "Computer Use request is missing its absolute deadline")
        }
        guard deadline > nowUnixMilliseconds else {
            throw CUError("deadline_exceeded", "Computer Use request expired before execution")
        }
        guard let sessionId = request.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty,
              let turnId = request.turnId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !turnId.isEmpty else {
            throw CUError("missing_turn_metadata", "Computer Use request is missing session/turn identity")
        }
        return Metadata(sessionId: sessionId, turnId: turnId)
    }

    static func hello() -> JSONValue {
        .object([
            "protocolVersion": .string(version),
            "supportsAbsoluteDeadlines": .bool(true),
            "supportsTurnEnd": .bool(true),
            "supportsCaptureDiagnostics": .bool(true),
        ])
    }
}

/// Enforces one explicit turn at a time on the single authenticated connection.
/// Connection setup and diagnostics do not open a turn. Every semantic request
/// must keep the same identity until `turn_end` releases all turn-owned state.
struct DaemonTurnGate {
    private(set) var active: ComputerUseDaemonProtocol.Metadata?

    mutating func admit(
        _ metadata: ComputerUseDaemonProtocol.Metadata,
        command: String
    ) throws {
        if !ComputerUseDaemonProtocol.isTurnScoped(command: command) { return }
        if let active {
            guard active == metadata else {
                throw CUError(
                    "turn_mismatch",
                    "A different Computer Use turn is still active; finish it before starting another"
                )
            }
            return
        }
        active = metadata
    }

    mutating func finish(
        _ metadata: ComputerUseDaemonProtocol.Metadata
    ) throws {
        guard active == metadata else {
            throw CUError("turn_mismatch", "Computer Use turn_end did not match the active turn")
        }
        active = nil
    }

    mutating func reset() {
        active = nil
    }
}
