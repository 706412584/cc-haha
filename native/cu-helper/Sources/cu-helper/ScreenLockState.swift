import CoreGraphics
import Foundation

/// Whether the login session's screen is locked.
///
/// Why this is an actuation gate and not a nicety: with the screen locked the
/// window server still accepts synthesized input, but the target app never sees
/// it — actions "succeed" and change nothing. That is the exact failure shape
/// this engine is built to refuse: a receipt that claims an effect it did not
/// have sends the model off correcting a UI it can no longer observe.
///
/// Codex gates the same way (`ServerErrorCode.screenLocked = -10020`, and its
/// service imports `CGSessionCopyCurrentDictionary` for precisely this read).
///
/// Fails OPEN, deliberately: an unreadable session dictionary means "unknown",
/// and refusing every action on an unknown is worse than the occasional lost
/// action — the lock state is a guard, not the authorization boundary.
enum ScreenLockState {
    /// The documented key inside the session dictionary.
    static let lockedKey = "CGSSessionScreenIsLocked"

    /// Pure decision over an already-read session dictionary, so the policy is
    /// testable without a login session.
    static func isLocked(sessionDictionary: [String: Any]?) -> Bool {
        guard let sessionDictionary else { return false }
        // CFBoolean bridges to NSNumber; anything non-boolean is not a lock signal.
        guard let value = sessionDictionary[lockedKey] as? NSNumber else { return false }
        return value.boolValue
    }

    /// Live read of the current login session.
    static func isLocked() -> Bool {
        isLocked(sessionDictionary: currentSessionDictionary())
    }

    private static func currentSessionDictionary() -> [String: Any]? {
        CGSessionCopyCurrentDictionary() as? [String: Any]
    }
}
