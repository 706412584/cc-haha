import XCTest
@testable import cc_haha_computer_use

final class DaemonSessionGateTests: XCTestCase {
    func testDisconnectedInflightSessionDefersCleanupAndRejectsNewConnection() {
        var gate = DaemonSessionGate()
        let first = acceptedGeneration(gate.acceptConnection())
        XCTAssertTrue(gate.beginRequest(generation: first))

        XCTAssertEqual(
            gate.disconnect(generation: first),
            .deferCleanup
        )
        XCTAssertEqual(gate.acceptConnection(), .rejectBusy)
        XCTAssertFalse(gate.beginRequest(generation: first))

        XCTAssertEqual(
            gate.finishRequest(generation: first),
            .terminateNow
        )
        let second = acceptedGeneration(gate.acceptConnection())
        XCTAssertGreaterThan(second, first)
    }

    func testIdleSupersedeInvalidatesEveryQueuedOldRequest() {
        var gate = DaemonSessionGate()
        let first = acceptedGeneration(gate.acceptConnection())

        let decision = gate.acceptConnection()
        guard case let .accept(second, cleanupSuperseded) = decision else {
            return XCTFail("expected accepted superseding connection")
        }
        XCTAssertTrue(cleanupSuperseded)
        XCTAssertFalse(gate.beginRequest(generation: first))
        XCTAssertTrue(gate.beginRequest(generation: second))
        XCTAssertEqual(gate.finishRequest(generation: second), .none)
    }

    func testIdleDisconnectTerminatesImmediatelyAndStaleCallbacksAreIgnored() {
        var gate = DaemonSessionGate()
        let first = acceptedGeneration(gate.acceptConnection())

        XCTAssertEqual(gate.disconnect(generation: first), .terminateNow)
        XCTAssertEqual(gate.disconnect(generation: first), .none)
        XCTAssertEqual(gate.finishRequest(generation: first), .none)
        XCTAssertFalse(gate.beginRequest(generation: first))
    }

    func testOnlyOneRequestCanBeInflightPerGeneration() {
        var gate = DaemonSessionGate()
        let generation = acceptedGeneration(gate.acceptConnection())

        XCTAssertTrue(gate.beginRequest(generation: generation))
        XCTAssertFalse(gate.beginRequest(generation: generation))
        XCTAssertEqual(gate.finishRequest(generation: generation), .none)
        XCTAssertTrue(gate.beginRequest(generation: generation))
    }

    func testSupersededConnectionCloseCannotTerminateReplacement() {
        var gate = DaemonSessionGate()
        let first = acceptedGeneration(gate.acceptConnection())
        let second = acceptedGeneration(gate.acceptConnection())

        XCTAssertEqual(gate.disconnect(generation: first), .none)
        XCTAssertTrue(gate.beginRequest(generation: second))
        XCTAssertEqual(gate.finishRequest(generation: second), .none)
    }

    func testConnectionTokenInvalidationIsPermanent() {
        let token = DaemonSessionToken()
        XCTAssertTrue(token.isValid)
        token.invalidate()
        XCTAssertFalse(token.isValid)
        token.invalidate()
        XCTAssertFalse(token.isValid)
    }

    private func acceptedGeneration(
        _ decision: DaemonSessionGate.AcceptDecision
    ) -> UInt64 {
        guard case let .accept(generation, _) = decision else {
            XCTFail("expected accepted connection")
            return 0
        }
        return generation
    }
}
