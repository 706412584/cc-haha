import XCTest
@testable import cc_haha_computer_use

final class DisplaySleepAssertionTests: XCTestCase {
    @MainActor
    func testTurnAssertionIsAcquiredAndReleasedExactlyOnce() {
        var creates = 0
        var releases: [UInt32] = []
        let assertion = ComputerUseDisplaySleepAssertion(
            create: {
                creates += 1
                return 42
            },
            release: { releases.append($0) }
        )

        assertion.acquire()
        assertion.acquire()
        XCTAssertTrue(assertion.isHeldForTesting)
        XCTAssertEqual(creates, 1)

        assertion.release()
        assertion.release()
        XCTAssertFalse(assertion.isHeldForTesting)
        XCTAssertEqual(releases, [42])

        assertion.acquire()
        XCTAssertEqual(creates, 2)
    }

    @MainActor
    func testFailedPowerAssertionDoesNotPretendItIsHeld() {
        let assertion = ComputerUseDisplaySleepAssertion(create: { nil })

        assertion.acquire()

        XCTAssertFalse(assertion.isHeldForTesting)
    }
}
