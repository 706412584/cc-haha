import AppKit

/// Makes an explicitly authorized app actionable when macOS has removed all of
/// its windows from the current on-screen window list.
///
/// Ordinary background windows stay untouched. Recovery is reserved for the
/// three states that cannot be reached by window-bound input: a hidden app, a
/// minimized window, or a window on another Space. Recovery uses only AppKit
/// activation plus the public writable AXMinimized window attribute; no shell
/// or AppleScript fallback is involved.
@MainActor
enum TargetWindowRecovery {
    enum Outcome: Equatable {
        case alreadyOnScreen
        case recovered
    }

    struct Runtime {
        var currentIdentity: (pid_t) -> AXTreeProcessIdentity?
        var hasOnScreenWindow: (pid_t) -> Bool
        var requestRecovery: (ProvenProcessTarget) -> Bool
        var pause: () async throws -> Void
        var attempts: Int = 20

        @MainActor static let live = Runtime(
            currentIdentity: { AXTree.currentProcessIdentity(pid: $0) },
            hasOnScreenWindow: { WindowGeometry.hasWindowOnScreen(pid: $0) },
            requestRecovery: { requestNativeRecovery(target: $0) },
            pause: { try await Task.sleep(for: .milliseconds(100)) }
        )
    }

    /// Type-erased native handles keep the recovery policy testable at the same
    /// seam used by AppKit and AX, without granting tests access to real apps.
    struct NativeWindow {
        var isMinimized: () -> Bool?
        var setMinimized: (Bool) -> Bool
    }

    struct NativeApplication {
        let identity: AXTreeProcessIdentity
        var isTerminated: () -> Bool
        var isHidden: () -> Bool
        var unhide: () -> Bool
        var windows: () -> [NativeWindow]
        var activateAllWindows: () -> Bool
    }

    struct NativeRuntime {
        var application: (pid_t) -> NativeApplication?

        @MainActor static let live = NativeRuntime(application: { pid in
            guard let running = NSRunningApplication(processIdentifier: pid) else {
                return nil
            }
            let appElement = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(appElement, 2.0)
            return NativeApplication(
                identity: AXTreeProcessIdentity(
                    bundleID: running.bundleIdentifier,
                    executablePath: running.executableURL?.path,
                    launchTime: running.launchDate?.timeIntervalSinceReferenceDate
                ),
                isTerminated: { running.isTerminated },
                isHidden: { running.isHidden },
                unhide: { running.unhide() },
                windows: { nativeWindows(appElement) },
                activateAllWindows: {
                    running.activate(options: [.activateAllWindows])
                }
            )
        })
    }

    /// Revalidates the exact NSRunningApplication object before touching any of
    /// its AX windows. A PID-only lookup is insufficient because macOS can reuse
    /// the number after the explicitly authorized process exits.
    static func requestNativeRecovery(
        target: ProvenProcessTarget,
        runtime: NativeRuntime = .live
    ) -> Bool {
        guard let application = runtime.application(target.pid),
              target.validatedPid(currentIdentity: application.identity) != nil,
              !application.isTerminated() else { return false }

        var accepted = false
        if application.isHidden() {
            accepted = application.unhide()
        }
        guard !application.isTerminated() else { return accepted }
        let windows = application.windows()
        guard !application.isTerminated() else { return accepted }
        if let minimizedWindow = windows.first(where: {
            $0.isMinimized() == true
        }) {
            accepted = minimizedWindow.setMinimized(false) || accepted
        }

        // Activation moves hidden/other-Space windows into view but does not
        // deminiaturize a native document window (verified with TextEdit). The
        // AX transition above is therefore intentionally before activation.
        guard !application.isTerminated() else { return accepted }
        return application.activateAllWindows() || accepted
    }

    static func recoverIfNeeded(
        target: ProvenProcessTarget,
        runtime: Runtime = .live
    ) async throws -> Outcome {
        try validateIdentity(target, runtime: runtime)
        if runtime.hasOnScreenWindow(target.pid) {
            return .alreadyOnScreen
        }

        let recoveryAccepted = runtime.requestRecovery(target)

        // The request is asynchronous and AppKit explicitly says acceptance is
        // not proof of activation. Check once immediately, then yield the main
        // run loop for a bounded Space/window transition.
        try validateIdentity(target, runtime: runtime)
        if runtime.hasOnScreenWindow(target.pid) {
            return .recovered
        }
        for _ in 0..<max(0, runtime.attempts) {
            try Task.checkCancellation()
            try await runtime.pause()
            try validateIdentity(target, runtime: runtime)
            if runtime.hasOnScreenWindow(target.pid) {
                return .recovered
            }
        }

        let reason = recoveryAccepted
            ? "macOS accepted recovery, but no target window appeared on screen"
            : "macOS refused the target app recovery request"
        throw CUError(
            "target_window_offscreen",
            "Computer Use could not restore the explicitly selected app: \(reason). No state snapshot was published."
        )
    }

    private static func validateIdentity(
        _ target: ProvenProcessTarget,
        runtime: Runtime
    ) throws {
        guard runtime.currentIdentity(target.pid) == target.identity else {
            throw CUError(
                "stale_process",
                "The target process changed while restoring its window. No state snapshot was published."
            )
        }
    }

    private static func nativeWindows(_ app: AXUIElement) -> [NativeWindow] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            app,
            kAXWindowsAttribute as CFString,
            &raw
        ) == .success,
        let elements = raw as? [AXUIElement] else { return [] }

        return elements.map { element in
            NativeWindow(
                isMinimized: { minimizedValue(element) },
                setMinimized: { minimized in
                    AXUIElementSetAttributeValue(
                        element,
                        kAXMinimizedAttribute as CFString,
                        minimized ? kCFBooleanTrue : kCFBooleanFalse
                    ) == .success
                }
            )
        }
    }

    private static func minimizedValue(_ window: AXUIElement) -> Bool? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            window,
            kAXMinimizedAttribute as CFString,
            &raw
        ) == .success,
        let raw,
        CFGetTypeID(raw) == CFBooleanGetTypeID() else { return nil }
        return CFBooleanGetValue((raw as! CFBoolean))
    }
}
