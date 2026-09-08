import XCTest

@testable import cc_haha_computer_use

final class UISettlePolicyTests: XCTestCase {
    /// Nothing has been mutated, so nothing is mid-transition on our account.
    /// This is the common case for the first `get_app_state` of a session and
    /// must not add capture latency.
    func testNoMutationMeansNoWait() {
        XCTAssertEqual(
            UISettlePolicy.delay(now: 100, lastMutationAt: nil, appIsBusy: false),
            0
        )
        XCTAssertEqual(
            UISettlePolicy.delay(now: 100, lastMutationAt: nil, appIsBusy: true),
            0
        )
    }

    /// A mutation that just landed owes almost the whole window.
    func testFreshMutationWaitsOutTheWindow() {
        let delay = UISettlePolicy.delay(now: 100.0, lastMutationAt: 99.9, appIsBusy: false)
        XCTAssertEqual(delay, UISettlePolicy.postActionWindow - 0.1, accuracy: 0.0001)
    }

    /// The model's own round-trip usually covers the settle window. When it
    /// does, we add nothing — this is why the wait belongs at capture time
    /// rather than after every action.
    func testElapsedWindowCostsNothing() {
        XCTAssertEqual(
            UISettlePolicy.delay(now: 100, lastMutationAt: 98.9, appIsBusy: false),
            0
        )
    }

    /// A permanently spinning progress indicator must not turn the one-shot
    /// settle into a multi-second stall.
    func testBusyAppUsesTheSameBoundedOneShotWindow() {
        let busy = UISettlePolicy.delay(now: 100, lastMutationAt: 98.9, appIsBusy: true)
        XCTAssertEqual(busy, 0)
        XCTAssertEqual(UISettlePolicy.busyWindow, UISettlePolicy.postActionWindow)

        XCTAssertEqual(
            UISettlePolicy.delay(
                now: 100,
                lastMutationAt: 100 - UISettlePolicy.busyWindow - 1,
                appIsBusy: true
            ),
            0
        )
    }

    /// Waiting less than a frame boundary is pure latency for no benefit.
    func testWaitIsEitherZeroOrWorthTaking() {
        let delay = UISettlePolicy.delay(
            now: 100,
            lastMutationAt: 100 - UISettlePolicy.postActionWindow + 0.001,
            appIsBusy: false
        )
        XCTAssertGreaterThanOrEqual(delay, UISettlePolicy.minimumWait)
    }

    /// A backwards clock (or a caller handing us a future stamp) must not turn
    /// into an unbounded wait.
    func testFutureStampDoesNotProduceAnUnboundedWait() {
        let delay = UISettlePolicy.delay(now: 100, lastMutationAt: 500, appIsBusy: false)
        XCTAssertLessThanOrEqual(delay, UISettlePolicy.postActionWindow)
        XCTAssertGreaterThanOrEqual(delay, 0)
    }

    @MainActor
    func testMutationMarkerIsScopedByPIDAndConsumedOnce() {
        MutationClock.resetForTests()
        defer { MutationClock.resetForTests() }

        MutationClock.recordMutation(pid: 101, at: 42)

        XCTAssertNil(MutationClock.takeMutation(pid: 202))
        XCTAssertEqual(MutationClock.takeMutation(pid: 101), 42)
        XCTAssertNil(MutationClock.takeMutation(pid: 101))
    }
}
