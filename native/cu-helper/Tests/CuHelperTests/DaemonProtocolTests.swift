import XCTest
@testable import cc_haha_computer_use

final class DaemonProtocolTests: XCTestCase {
    private func request(
        version: String? = ComputerUseDaemonProtocol.version,
        deadline: Int64? = 2_000,
        sessionId: String? = "session-a",
        turnId: String? = "turn-a",
        id: String? = "request-a",
        requestId: String? = "request-a",
        command: String = "get_app_state"
    ) -> Request {
        Request(
            id: id,
            cmd: command,
            payload: .object([:]),
            clientApiVersion: version,
            deadlineUnixMilliseconds: deadline,
            sessionId: sessionId,
            turnId: turnId,
            requestId: requestId
        )
    }

    func testValidRequestCarriesVersionDeadlineAndTurnIdentity() throws {
        let metadata = try ComputerUseDaemonProtocol.validate(
            request(),
            nowUnixMilliseconds: 1_000
        )

        XCTAssertEqual(metadata.sessionId, "session-a")
        XCTAssertEqual(metadata.turnId, "turn-a")
    }

    func testProtocolMismatchAndExpiredDeadlineFailClosed() {
        XCTAssertThrowsError(try ComputerUseDaemonProtocol.validate(
            request(version: "CCHahaComputerUseIPC-1"),
            nowUnixMilliseconds: 1_000
        )) { error in
            XCTAssertEqual((error as? CUError)?.code, "protocol_mismatch")
        }

        XCTAssertThrowsError(try ComputerUseDaemonProtocol.validate(
            request(deadline: 1_000),
            nowUnixMilliseconds: 1_000
        )) { error in
            XCTAssertEqual((error as? CUError)?.code, "deadline_exceeded")
        }
    }

    func testRequestIdentityAndTurnMetadataCannotBeOmitted() {
        XCTAssertThrowsError(try ComputerUseDaemonProtocol.validate(
            request(requestId: "different"),
            nowUnixMilliseconds: 1_000
        )) { error in
            XCTAssertEqual((error as? CUError)?.code, "bad_request_id")
        }

        XCTAssertThrowsError(try ComputerUseDaemonProtocol.validate(
            request(turnId: "  "),
            nowUnixMilliseconds: 1_000
        )) { error in
            XCTAssertEqual((error as? CUError)?.code, "missing_turn_metadata")
        }
    }

    func testTurnGateRejectsCrossTurnStateUntilMatchingEnd() throws {
        let first = ComputerUseDaemonProtocol.Metadata(
            sessionId: "session-a",
            turnId: "turn-a"
        )
        let second = ComputerUseDaemonProtocol.Metadata(
            sessionId: "session-a",
            turnId: "turn-b"
        )
        var gate = DaemonTurnGate()

        try gate.admit(first, command: "get_app_state")
        try gate.admit(first, command: "click")
        XCTAssertThrowsError(try gate.admit(second, command: "get_app_state")) {
            XCTAssertEqual(($0 as? CUError)?.code, "turn_mismatch")
        }
        try gate.finish(first)
        try gate.admit(second, command: "get_app_state")
        XCTAssertEqual(gate.active, second)
    }

    func testPingNegotiatesWithoutOpeningATurn() throws {
        let metadata = ComputerUseDaemonProtocol.Metadata(
            sessionId: "session-a",
            turnId: "handshake-1"
        )
        var gate = DaemonTurnGate()

        try gate.admit(metadata, command: "ping")

        XCTAssertNil(gate.active)
        XCTAssertEqual(
            ComputerUseDaemonProtocol.hello()["protocolVersion"]?.asString,
            ComputerUseDaemonProtocol.version
        )
    }

    func testPermissionProbeIsConnectionScopedAndDoesNotOpenATurn() throws {
        let metadata = ComputerUseDaemonProtocol.Metadata(
            sessionId: "session-a",
            turnId: "probe"
        )
        var gate = DaemonTurnGate()

        try gate.admit(metadata, command: "check_permissions")

        XCTAssertNil(gate.active)
    }

    func testStartupAppEnumerationDoesNotPoisonResumedSessionTurn() throws {
        let bootstrap = ComputerUseDaemonProtocol.Metadata(
            sessionId: "bootstrap-session",
            turnId: "connection-1"
        )
        let resumed = ComputerUseDaemonProtocol.Metadata(
            sessionId: "resumed-session",
            turnId: "turn-a"
        )
        var gate = DaemonTurnGate()

        try gate.admit(bootstrap, command: "list_installed_apps")
        XCTAssertNil(gate.active)

        try gate.admit(resumed, command: "get_app_state")
        XCTAssertEqual(gate.active, resumed)
    }
}
