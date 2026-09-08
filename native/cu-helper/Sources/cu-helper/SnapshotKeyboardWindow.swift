import CoreGraphics

/// Keyboard focus belongs to the window published by get_app_state, not the
/// first layer-zero CG window (which can be a small auxiliary app window).
enum SnapshotKeyboardWindow {
    static func resolve(
        pid: pid_t,
        snapshot: AXTreeSnapshotEvidence?,
        currentIdentity: AXTreeProcessIdentity?,
        windowForID: (CGWindowID, pid_t) -> WindowGeometry.Window?
    ) throws -> WindowGeometry.Window {
        try SnapshotProcessGuard.validate(
            pid: pid, snapshot: snapshot, current: currentIdentity, expected: nil
        )
        guard let windowID = snapshot?.keyWindowID, windowID != kCGNullWindowID,
              let window = windowForID(windowID, pid),
              window.id == windowID, window.ownerPid == pid else {
            throw CUError(
                "stale_window",
                "The snapshot's keyboard target window is no longer available. Call get_app_state before typing or pressing keys."
            )
        }
        return window
    }
}
