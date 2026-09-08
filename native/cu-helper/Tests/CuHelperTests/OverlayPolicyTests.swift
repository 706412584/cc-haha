import Darwin
import XCTest

@testable import cc_haha_computer_use

final class OverlayPolicyTests: XCTestCase {
    private let processA = AXTreeProcessIdentity(
        bundleID: "com.example.a",
        executablePath: "/Applications/A.app/Contents/MacOS/A",
        launchTime: 100
    )

    /// The product's primary mode is BACKGROUND pid-targeted operation (the
    /// helper never foregrounds the target). An exposed background window —
    /// e.g. the target sitting alone on another display — must show the
    /// cursor, or the "watch the AI work" layer never exists in exactly the
    /// scenario the product is built for.
    func testExposedBackgroundTargetIsVisibleWithActionDelay() {
        let decision = OverlayPolicy.decision(
            targetPid: 41,
            frontmostPid: 99,
            overlayRequested: true,
            targetWindowExposed: true
        )

        XCTAssertTrue(decision.visible)
        XCTAssertGreaterThan(decision.actionDelay, 0)
        XCTAssertFalse(decision.shouldClearTransientVisuals)
    }

    /// A buried background target stays hidden: drawing a cursor above the
    /// OCCLUDING window's content would point at something unrelated.
    func testCoveredBackgroundTargetIsHiddenWithZeroActionDelay() {
        let decision = OverlayPolicy.decision(
            targetPid: 41,
            frontmostPid: 99,
            overlayRequested: true,
            targetWindowExposed: false
        )

        XCTAssertFalse(decision.visible)
        XCTAssertEqual(decision.actionDelay, 0)
        XCTAssertTrue(decision.shouldClearTransientVisuals)
    }

    /// Frontmost target is visible regardless of the exposure probe — the
    /// window-server evidence is redundant when macOS already says the target
    /// owns the screen.
    func testForegroundRequestedTargetIsVisibleWithShortActionDelay() {
        let decision = OverlayPolicy.decision(
            targetPid: 41,
            frontmostPid: 41,
            overlayRequested: true,
            targetWindowExposed: false
        )

        XCTAssertTrue(decision.visible)
        XCTAssertGreaterThan(decision.actionDelay, 0)
        XCTAssertLessThanOrEqual(decision.actionDelay, 0.12)
        XCTAssertFalse(decision.shouldClearTransientVisuals)
    }

    /// Exposure alone can never conjure visuals for a missing/invalid/
    /// unrequested target — identity comes first, always.
    func testNilInvalidAndUnrequestedTargetsStayHiddenEvenWhenExposed() {
        let decisions = [
            OverlayPolicy.decision(targetPid: nil, frontmostPid: 41, overlayRequested: true, targetWindowExposed: true),
            OverlayPolicy.decision(targetPid: 0, frontmostPid: 41, overlayRequested: true, targetWindowExposed: true),
            OverlayPolicy.decision(targetPid: -1, frontmostPid: 41, overlayRequested: true, targetWindowExposed: true),
            OverlayPolicy.decision(targetPid: 41, frontmostPid: 41, overlayRequested: false, targetWindowExposed: true),
        ]

        XCTAssertTrue(decisions.allSatisfy { !$0.visible && $0.actionDelay == 0 })
    }

    // MARK: - firstOrdinaryWindowOwner (pure exposure core)

    private func windowInfo(
        layer: Int,
        x: CGFloat,
        y: CGFloat,
        w: CGFloat,
        h: CGFloat,
        pid: pid_t
    ) -> [CFString: Any] {
        [
            kCGWindowLayer: layer,
            kCGWindowBounds: ["X": x, "Y": y, "Width": w, "Height": h] as [String: CGFloat],
            kCGWindowOwnerPID: pid,
        ]
    }

    /// Front-to-back: the FIRST ordinary window containing the point owns it.
    func testFrontmostOrdinaryWindowAtPointWins() {
        let list = [
            windowInfo(layer: 0, x: 0, y: 0, w: 500, h: 500, pid: 7),
            windowInfo(layer: 0, x: 0, y: 0, w: 500, h: 500, pid: 8),
        ]
        XCTAssertEqual(
            OverlayPolicy.firstOrdinaryWindowOwner(at: CGPoint(x: 10, y: 10), in: list),
            7
        )
    }

    /// Non-zero layers (our own overlay panels, menu bar, Dock) are invisible
    /// to the exposure probe — the overlay must never occlude its own target.
    func testNonZeroLayersAreIgnored() {
        let list = [
            windowInfo(layer: 2_000, x: 0, y: 0, w: 500, h: 500, pid: 7),
            windowInfo(layer: 0, x: 0, y: 0, w: 500, h: 500, pid: 8),
        ]
        XCTAssertEqual(
            OverlayPolicy.firstOrdinaryWindowOwner(at: CGPoint(x: 10, y: 10), in: list),
            8
        )
    }

    /// Windows not containing the point do not participate; over empty desktop
    /// there is no owner at all.
    func testPointOutsideAllWindowsHasNoOwner() {
        let list = [
            windowInfo(layer: 0, x: 100, y: 100, w: 50, h: 50, pid: 7)
        ]
        XCTAssertEqual(
            OverlayPolicy.firstOrdinaryWindowOwner(at: CGPoint(x: 120, y: 120), in: list),
            7
        )
        XCTAssertNil(
            OverlayPolicy.firstOrdinaryWindowOwner(at: CGPoint(x: 10, y: 10), in: list)
        )
    }

    /// Malformed window-server entries (missing keys, empty bounds) are
    /// skipped rather than trusted.
    func testMalformedEntriesAreSkipped() {
        let malformed: [[CFString: Any]] = [
            [kCGWindowLayer: 0],
            [kCGWindowLayer: 0, kCGWindowBounds: ["X": CGFloat(0), "Y": CGFloat(0), "Width": CGFloat(0), "Height": CGFloat(0)] as [String: CGFloat], kCGWindowOwnerPID: pid_t(9)],
            windowInfo(layer: 0, x: 0, y: 0, w: 100, h: 100, pid: 10),
        ]
        XCTAssertEqual(
            OverlayPolicy.firstOrdinaryWindowOwner(at: CGPoint(x: 5, y: 5), in: malformed),
            10
        )
    }

    // MARK: - WindowExposure cache

    /// Within the TTL the window list is read once; pid or point changes and
    /// TTL expiry each force a fresh read. An unreadable list fails closed.
    @MainActor
    func testExposureCacheAndFailClosed() {
        WindowExposure.resetForTests()
        defer { WindowExposure.resetForTests() }
        var reads = 0
        let list = [windowInfo(layer: 0, x: 0, y: 0, w: 500, h: 500, pid: 7)]

        let point = CGPoint(x: 10, y: 10)
        XCTAssertTrue(
            WindowExposure.targetWindowExposed(at: point, targetPid: 7, now: 100) { reads += 1; return list }
        )
        XCTAssertTrue(
            WindowExposure.targetWindowExposed(at: point, targetPid: 7, now: 100.05) { reads += 1; return list }
        )
        XCTAssertEqual(reads, 1, "second read inside TTL must hit the cache")

        XCTAssertTrue(
            WindowExposure.targetWindowExposed(at: point, targetPid: 7, now: 100.05 + WindowExposure.cacheTTL) { reads += 1; return list }
        )
        XCTAssertEqual(reads, 2, "TTL expiry must re-read")

        XCTAssertFalse(
            WindowExposure.targetWindowExposed(at: point, targetPid: 8, now: 100.05 + WindowExposure.cacheTTL) { reads += 1; return list },
            "different pid is a different question"
        )
        XCTAssertEqual(reads, 3)

        WindowExposure.resetForTests()
        XCTAssertFalse(
            WindowExposure.targetWindowExposed(at: point, targetPid: 7, now: 200) { nil },
            "unreadable window list must read as NOT exposed"
        )
    }

    // MARK: - Lifecycle (unchanged semantics)

    func testTransientHidePreservesActiveTrackingAndCanRevealAgain() {
        var lifecycle = OverlayLifecycleState()

        lifecycle.startTracking()
        XCTAssertTrue(lifecycle.isActive)
        XCTAssertFalse(lifecycle.isVisible)

        lifecycle.showWindow()
        XCTAssertTrue(lifecycle.isActive)
        XCTAssertTrue(lifecycle.isVisible)

        lifecycle.hideWindow()
        XCTAssertTrue(lifecycle.isActive)
        XCTAssertFalse(lifecycle.isVisible)

        lifecycle.showWindow()
        XCTAssertTrue(lifecycle.isVisible)
    }

    func testTerminalStopBecomesInactive() {
        var lifecycle = OverlayLifecycleState()
        lifecycle.startTracking()
        lifecycle.showWindow()

        lifecycle.stopTracking()

        XCTAssertFalse(lifecycle.isActive)
        XCTAssertFalse(lifecycle.isVisible)
    }

    func testStaleResolvedPairWithReusedPIDCannotRebindVisuals() throws {
        let stale = try XCTUnwrap(ProvenProcessTarget(pid: 41, identity: processA))
        let replacement = AXTreeProcessIdentity(
            bundleID: "com.example.b",
            executablePath: "/Applications/B.app/Contents/MacOS/B",
            launchTime: 200
        )

        XCTAssertNil(stale.validatedPid(currentIdentity: replacement))
    }

    func testNewExplicitResolvedPairCanBindMatchingProcessLifetime() throws {
        let resolved = try XCTUnwrap(ProvenProcessTarget(pid: 41, identity: processA))

        XCTAssertEqual(resolved.validatedPid(currentIdentity: processA), 41)
    }
}
