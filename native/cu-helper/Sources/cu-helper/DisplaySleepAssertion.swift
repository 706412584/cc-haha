import Foundation
import IOKit.pwr_mgt

/// Keeps the display compositor awake while a Computer Use turn is active.
/// Covered-window ScreenCaptureKit consumers can otherwise stop receiving
/// useful updates once macOS enters user-idle display sleep during a long task.
@MainActor
final class ComputerUseDisplaySleepAssertion {
    typealias AssertionID = IOPMAssertionID

    private let create: () -> AssertionID?
    private let releaseAssertion: (AssertionID) -> Void
    private var assertionID: AssertionID?

    init(
        create: @escaping () -> AssertionID? = {
            var assertionID: IOPMAssertionID = 0
            let result = IOPMAssertionCreateWithDescription(
                kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                "Claude Code Haha Computer Use interaction" as CFString,
                "Computer Use turn is controlling a background application" as CFString,
                "Keeping the display awake while Computer Use is active" as CFString,
                nil,
                0,
                nil,
                &assertionID
            )
            return result == kIOReturnSuccess ? assertionID : nil
        },
        release: @escaping (AssertionID) -> Void = { assertionID in
            _ = IOPMAssertionRelease(assertionID)
        }
    ) {
        self.create = create
        self.releaseAssertion = release
    }

    func acquire() {
        guard assertionID == nil else { return }
        assertionID = create()
    }

    func release() {
        guard let assertionID else { return }
        self.assertionID = nil
        releaseAssertion(assertionID)
    }

    var isHeldForTesting: Bool { assertionID != nil }
}
