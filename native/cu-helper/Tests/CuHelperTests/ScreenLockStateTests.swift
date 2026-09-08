import XCTest

@testable import cc_haha_computer_use

/// A locked screen swallows synthesized input silently: the window server takes
/// it, no app sees it, and the action reports success having changed nothing.
/// That is the failure shape the whole engine is built to refuse, so the gate
/// has to be exactly right in both directions.
final class ScreenLockStateTests: XCTestCase {
    func testLockedSessionIsDetected() {
        XCTAssertTrue(
            ScreenLockState.isLocked(sessionDictionary: [ScreenLockState.lockedKey: NSNumber(value: true)])
        )
    }

    func testUnlockedSessionIsNotLocked() {
        XCTAssertFalse(
            ScreenLockState.isLocked(sessionDictionary: [ScreenLockState.lockedKey: NSNumber(value: false)])
        )
    }

    /// Fails OPEN on purpose. An unreadable or key-less session dictionary means
    /// "unknown", and blocking every action on unknown would be a worse product
    /// than the rare lost action — this is a guard, not the security boundary
    /// (that is client attestation plus the per-app grant).
    func testUnknownSessionStateDoesNotBlockActions() {
        XCTAssertFalse(ScreenLockState.isLocked(sessionDictionary: nil))
        XCTAssertFalse(ScreenLockState.isLocked(sessionDictionary: [:]))
        XCTAssertFalse(ScreenLockState.isLocked(sessionDictionary: ["SomethingElse": NSNumber(value: true)]))
    }

    /// A non-boolean under the lock key is not a lock signal — coercing a string
    /// or a count into "locked" would strand the user with a dead engine.
    func testNonBooleanValueIsNotALockSignal() {
        XCTAssertFalse(ScreenLockState.isLocked(sessionDictionary: [ScreenLockState.lockedKey: "true"]))
        XCTAssertFalse(ScreenLockState.isLocked(sessionDictionary: [ScreenLockState.lockedKey: NSNull()]))
    }

    /// The key is a documented CoreGraphics session constant; a typo here would
    /// silently disable the gate forever, and nothing else would notice.
    func testLockKeyMatchesTheDocumentedSessionConstant() {
        XCTAssertEqual(ScreenLockState.lockedKey, "CGSSessionScreenIsLocked")
    }

    /// The live read must not crash or hang on a normal unlocked session — this
    /// runs on every mutating action.
    func testLiveReadIsSafeToCallOnEveryAction() {
        _ = ScreenLockState.isLocked()
    }
}
