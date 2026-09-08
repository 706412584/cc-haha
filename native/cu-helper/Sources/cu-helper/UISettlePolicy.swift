import Foundation

/// How long to let the UI settle before capturing state for the model.
///
/// The problem this solves: a mutating action returns a receipt immediately,
/// and the model calls `get_app_state` when it wants to see the result. If that
/// capture lands while the app is still animating — a sheet sliding in, a list
/// repopulating — the model gets a mid-transition frame and reasons about a UI
/// that no longer exists a moment later.
///
/// The fix is NOT to sleep after every action. That was the old design, and it
/// charged every action a fixed 150ms whether or not anyone was about to look:
/// it made sense only while the router re-captured state after each mutation,
/// which it no longer does. Instead the wait happens once, at the moment of
/// capture, and only if an action happened recently enough to still be settling.
///
/// This mirrors Codex's one-shot `needsUISettleBeforeSkyshot`: the next capture
/// for that target waits about 250ms after a recent action. A different app and
/// later captures do not inherit the wait.
///
/// Pure and clock-injected so the decision is testable without sleeping.
enum UISettlePolicy {
    /// How long after a mutation the UI is presumed to still be settling.
    static let postActionWindow: TimeInterval = 0.25

    /// Kept as a named compatibility seam for callers that already compute a
    /// busy signal. Codex does not turn that signal into a multi-second sleep;
    /// freshness comes from subsequent on-demand captures instead.
    static let busyWindow: TimeInterval = postActionWindow

    /// Never wait less than this once we've decided to wait at all — a delay
    /// too short to cover a frame boundary is just latency for nothing.
    static let minimumWait: TimeInterval = 0.05

    /// Seconds to wait before capturing.
    ///
    /// - Parameters:
    ///   - now: current monotonic time.
    ///   - lastMutationAt: when the last mutating action completed, if any.
    ///   - appIsBusy: whether the target still shows a progress/busy indicator.
    /// - Returns: 0 when nothing is pending; otherwise the remaining settle time.
    static func delay(
        now: TimeInterval,
        lastMutationAt: TimeInterval?,
        appIsBusy: Bool
    ) -> TimeInterval {
        // No action has happened in this process — whatever is on screen has
        // been there a while and is not mid-transition because of us.
        guard let lastMutationAt else { return 0 }

        // A clock that ran backwards (or a caller passing a future stamp) must
        // not translate into an unbounded wait.
        let elapsed = max(0, now - lastMutationAt)
        let window = appIsBusy ? busyWindow : postActionWindow
        let remaining = window - elapsed
        if remaining <= 0 { return 0 }
        return max(minimumWait, remaining)
    }
}

/// Records one pending capture settle per target process, so an action in one
/// app cannot delay a screenshot of another app.
///
/// `@MainActor` because every mutation already runs there; this keeps the state
/// single-threaded without a lock.
@MainActor
enum MutationClock {
    private static var pendingByPID: [pid_t: TimeInterval] = [:]
    private static var unscopedMutationAt: TimeInterval?

    /// Called by the action path after a mutation lands. Does not sleep.
    static func recordMutation(
        pid: pid_t? = nil,
        at time: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
        if let pid {
            pendingByPID[pid] = time
        } else {
            unscopedMutationAt = time
        }
    }

    static func lastMutation(pid: pid_t? = nil) -> TimeInterval? {
        guard let pid else { return unscopedMutationAt }
        return pendingByPID[pid]
    }

    /// Consume the one-shot marker before waiting. Another capture cannot pay
    /// the same action's settle cost a second time.
    static func takeMutation(pid: pid_t? = nil) -> TimeInterval? {
        guard let pid else {
            defer { unscopedMutationAt = nil }
            return unscopedMutationAt
        }
        return pendingByPID.removeValue(forKey: pid)
    }

    /// Wait out whatever settle time the last mutation still owes.
    ///
    /// Uses `Task.sleep`, not `Thread.sleep`: this runs on the main actor, where
    /// blocking would starve the overlay's display link and freeze the virtual
    /// cursor animation mid-glide.
    static func awaitSettle(
        lastMutationAt: TimeInterval?,
        appIsBusy: Bool
    ) async {
        let delay = UISettlePolicy.delay(
            now: ProcessInfo.processInfo.systemUptime,
            lastMutationAt: lastMutationAt,
            appIsBusy: appIsBusy
        )
        guard delay > 0 else { return }
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
    }

    static func reset() {
        pendingByPID.removeAll()
        unscopedMutationAt = nil
    }

    static func resetForTests() { reset() }
}
