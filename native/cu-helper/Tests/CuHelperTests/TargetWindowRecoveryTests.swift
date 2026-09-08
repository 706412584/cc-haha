import XCTest

@testable import cc_haha_computer_use

@MainActor
final class TargetWindowRecoveryTests: XCTestCase {
    private let pid: pid_t = 72_041
    private let identity = AXTreeProcessIdentity(
        bundleID: "com.apple.TextEdit",
        executablePath: "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
        launchTime: 44
    )

    func testMinimizedNativeWindowIsDeminimizedBeforeActivationCanReportRecovery() async throws {
        let window = AXWindowHarness(minimized: true)

        var activationPIDs: [pid_t] = []
        let nativeRuntime = TargetWindowRecovery.NativeRuntime(
            application: { [identity] requestedPID in
                XCTAssertEqual(requestedPID, self.pid)
                return TargetWindowRecovery.NativeApplication(
                    identity: identity,
                    isTerminated: { false },
                    isHidden: { false },
                    unhide: { XCTFail("a minimized visible app must not be unhidden"); return false },
                    windows: {
                        [TargetWindowRecovery.NativeWindow(
                            isMinimized: { window.minimized },
                            setMinimized: { minimized in
                                window.minimizedWrites.append(minimized)
                                window.minimized = minimized
                                return true
                            }
                        )]
                    },
                    activateAllWindows: {
                        activationPIDs.append(requestedPID)
                        return true
                    }
                )
            }
        )
        var pauseCount = 0
        let runtime = TargetWindowRecovery.Runtime(
            currentIdentity: { [identity] _ in identity },
            hasOnScreenWindow: { _ in window.isOnScreen },
            requestRecovery: { target in
                TargetWindowRecovery.requestNativeRecovery(
                    target: target,
                    runtime: nativeRuntime
                )
            },
            pause: { pauseCount += 1 }
        )

        let result = try await TargetWindowRecovery.recoverIfNeeded(
            target: try target(),
            runtime: runtime
        )

        XCTAssertEqual(result, .recovered)
        XCTAssertFalse(window.minimized)
        XCTAssertTrue(window.isOnScreen)
        XCTAssertEqual(window.minimizedWrites, [false])
        XCTAssertEqual(activationPIDs, [pid])
        XCTAssertEqual(pauseCount, 0)
    }

    func testPIDReuseIsRejectedBeforeAnyNativeWindowMutation() throws {
        let replacement = AXTreeProcessIdentity(
            bundleID: identity.bundleID,
            executablePath: identity.executablePath,
            launchTime: 45
        )
        let window = AXWindowHarness(minimized: true)
        var activated = false
        let runtime = TargetWindowRecovery.NativeRuntime(
            application: { [replacement] _ in
                TargetWindowRecovery.NativeApplication(
                    identity: replacement,
                    isTerminated: { false },
                    isHidden: { false },
                    unhide: { XCTFail("a replacement process must not be unhidden"); return true },
                    windows: {
                        window.readCount += 1
                        return [TargetWindowRecovery.NativeWindow(
                            isMinimized: { window.minimized },
                            setMinimized: { value in
                                window.minimizedWrites.append(value)
                                window.minimized = value
                                return true
                            }
                        )]
                    },
                    activateAllWindows: {
                        activated = true
                        return true
                    }
                )
            }
        )

        XCTAssertFalse(TargetWindowRecovery.requestNativeRecovery(
            target: try target(),
            runtime: runtime
        ))
        XCTAssertEqual(window.readCount, 0)
        XCTAssertTrue(window.minimizedWrites.isEmpty)
        XCTAssertTrue(window.minimized)
        XCTAssertFalse(activated)
    }

    func testHiddenAndOtherSpaceTargetsTransitionBackOnScreen() async throws {
        for placement in RecoveryHarness.Placement.activationCases {
            let harness = RecoveryHarness(pid: pid, identity: identity, placement: placement)

            let result = try await TargetWindowRecovery.recoverIfNeeded(
                target: try target(),
                runtime: harness.runtime()
            )

            XCTAssertEqual(result, .recovered, "placement: \(placement)")
            XCTAssertEqual(harness.activationPIDs, [pid], "placement: \(placement)")
            XCTAssertEqual(harness.placement, .onScreen, "placement: \(placement)")
        }
    }

    func testAlreadyOnScreenBackgroundTargetIsNotActivated() async throws {
        let harness = RecoveryHarness(pid: pid, identity: identity, placement: .onScreen)

        let result = try await TargetWindowRecovery.recoverIfNeeded(
            target: try target(),
            runtime: harness.runtime()
        )

        XCTAssertEqual(result, .alreadyOnScreen)
        XCTAssertTrue(harness.activationPIDs.isEmpty)
        XCTAssertEqual(harness.pauseCount, 0)
    }

    func testAcceptedActivationThatNeverProducesAWindowFailsClosed() async throws {
        let harness = RecoveryHarness(
            pid: pid,
            identity: identity,
            placement: .otherSpace,
            transitionAfterPauses: nil,
            activationAccepted: true
        )

        do {
            _ = try await TargetWindowRecovery.recoverIfNeeded(
                target: try target(),
                runtime: harness.runtime(attempts: 2)
            )
            XCTFail("an accepted activation is not proof that a window became available")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "target_window_offscreen")
        }

        XCTAssertEqual(harness.activationPIDs, [pid])
        XCTAssertEqual(harness.pauseCount, 2)
        XCTAssertEqual(harness.placement, .otherSpace)
    }

    func testRejectedActivationNeverReportsRecovery() async throws {
        let harness = RecoveryHarness(
            pid: pid,
            identity: identity,
            placement: .minimized,
            transitionAfterPauses: nil,
            activationAccepted: false
        )

        do {
            _ = try await TargetWindowRecovery.recoverIfNeeded(
                target: try target(),
                runtime: harness.runtime(attempts: 1)
            )
            XCTFail("a rejected activation must fail")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "target_window_offscreen")
            XCTAssertTrue(error.message.contains("refused"))
        }

        XCTAssertEqual(harness.activationPIDs, [pid])
        XCTAssertEqual(harness.placement, .minimized)
    }

    func testProcessReplacementDuringRecoveryCannotInheritSuccess() async throws {
        let replacement = AXTreeProcessIdentity(
            bundleID: identity.bundleID,
            executablePath: identity.executablePath,
            launchTime: 45
        )
        let harness = RecoveryHarness(
            pid: pid,
            identity: identity,
            placement: .hidden,
            transitionAfterPauses: 1,
            replacementAfterPauses: (1, replacement)
        )

        do {
            _ = try await TargetWindowRecovery.recoverIfNeeded(
                target: try target(),
                runtime: harness.runtime()
            )
            XCTFail("a replacement process must not inherit the original recovery")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "stale_process")
        }
    }

    func testGetAppStateJoinsRecoveryBeforePublishingANewSnapshot() throws {
        let source = try String(
            contentsOf: sourceURL("CommandRouter.swift"),
            encoding: .utf8
        )
        let start = try XCTUnwrap(source.range(of: "private func handleGetAppState"))
        let body = String(source[start.lowerBound...].prefix(8_000))
        let recovery = try XCTUnwrap(body.range(of: "TargetWindowRecovery.recoverIfNeeded"))
        let snapshot = try XCTUnwrap(body.range(of: "AXTree.appState"))
        let authorization = try XCTUnwrap(body.range(of: "authorizeResolvedTarget"))

        XCTAssertLessThan(authorization.lowerBound, recovery.lowerBound)
        XCTAssertLessThan(
            recovery.lowerBound,
            snapshot.lowerBound,
            "the explicit target must be recoverable before AX publishes window identity and geometry"
        )
    }

    private func target() throws -> ProvenProcessTarget {
        try XCTUnwrap(ProvenProcessTarget(pid: pid, identity: identity))
    }

    private func sourceURL(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper")
            .appendingPathComponent(name)
    }
}

/// Stateful stand-in for the exact AXMinimized read/write seam used in
/// production. Visibility is derived from the attribute transition; neither
/// activation nor the polling harness can manufacture an on-screen result.
@MainActor
private final class AXWindowHarness {
    var minimized: Bool
    var minimizedWrites: [Bool] = []
    var readCount = 0

    init(minimized: Bool) {
        self.minimized = minimized
    }

    var isOnScreen: Bool { !minimized }
}

@MainActor
private final class RecoveryHarness {
    enum Placement: CaseIterable {
        case onScreen
        case hidden
        case minimized
        case otherSpace

        static let activationCases: [Placement] = [.hidden, .otherSpace]
    }

    let pid: pid_t
    var identity: AXTreeProcessIdentity
    var placement: Placement
    var activationPIDs: [pid_t] = []
    var pauseCount = 0

    private let transitionAfterPauses: Int?
    private let activationAccepted: Bool
    private let replacementAfterPauses: (count: Int, identity: AXTreeProcessIdentity)?
    private let originalIdentity: AXTreeProcessIdentity
    private var recoveryRequested = false

    init(
        pid: pid_t,
        identity: AXTreeProcessIdentity,
        placement: Placement,
        transitionAfterPauses: Int? = 1,
        activationAccepted: Bool = true,
        replacementAfterPauses: (Int, AXTreeProcessIdentity)? = nil
    ) {
        self.pid = pid
        self.identity = identity
        self.placement = placement
        self.transitionAfterPauses = transitionAfterPauses
        self.activationAccepted = activationAccepted
        self.replacementAfterPauses = replacementAfterPauses
        self.originalIdentity = identity
    }

    func runtime(attempts: Int = 20) -> TargetWindowRecovery.Runtime {
        TargetWindowRecovery.Runtime(
            currentIdentity: { [self] requestedPID in
                XCTAssertEqual(requestedPID, pid)
                return identity
            },
            hasOnScreenWindow: { [self] requestedPID in
                XCTAssertEqual(requestedPID, pid)
                return placement == .onScreen
            },
            requestRecovery: { [self] target in
                activationPIDs.append(target.pid)
                recoveryRequested = true
                return activationAccepted
            },
            pause: { [self] in
                pauseCount += 1
                if let replacementAfterPauses,
                   pauseCount == replacementAfterPauses.count {
                    identity = replacementAfterPauses.identity
                }
                if recoveryRequested,
                   let transitionAfterPauses,
                   pauseCount == transitionAfterPauses,
                   identity == originalIdentity {
                    placement = .onScreen
                }
            },
            attempts: attempts
        )
    }
}
