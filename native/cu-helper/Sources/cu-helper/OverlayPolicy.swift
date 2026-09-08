import CoreGraphics
import Darwin
import Foundation

/// Immutable resolver evidence for one process lifetime. Consumers may bind
/// visuals or foreground leases only while a fresh identity still matches.
struct ProvenProcessTarget: Equatable, Sendable {
    let pid: pid_t
    let identity: AXTreeProcessIdentity

    init?(pid: pid_t, identity: AXTreeProcessIdentity) {
        guard pid > 0, identity.isProven else { return nil }
        self.pid = pid
        self.identity = identity
    }

    func validatedPid(currentIdentity: AXTreeProcessIdentity?) -> pid_t? {
        guard currentIdentity?.isProven == true,
              currentIdentity == identity else { return nil }
        return pid
    }
}

/// One shared visibility decision for the glow, virtual cursor, ripple, and
/// action-motion delay. Callers pass `nil` when target identity cannot be
/// proven; a pid number by itself is never enough to make visuals visible.
///
/// Visibility rule: a proven, requested target is visible when it is frontmost
/// OR when its window is actually exposed at the point being acted on.
///
/// The second arm is what makes the cursor exist at all in this product's
/// primary mode. Injection is PID-targeted (`postToPid`) precisely so the
/// agent can operate an app WITHOUT foregrounding it — e.g. the target on one
/// display while the user works on another. The original frontmost-only rule
/// hid every visual in exactly that scenario, so the "watch the AI work"
/// layer never appeared for background operation. Exposure keeps the honest
/// half of the old rule: when the target window is fully covered by other
/// windows, drawing a cursor on top of the OCCLUDING window's content would
/// point at something unrelated — so a covered target stays hidden.
enum OverlayPolicy {
    struct Decision: Equatable, Sendable {
        let visible: Bool
        let actionDelay: TimeInterval

        var shouldClearTransientVisuals: Bool { !visible }
    }

    /// Applied whenever visuals are visible — foreground or exposed
    /// background — so the human eye can register the cursor before the
    /// action lands. (Historically foreground-only, but a watched background
    /// window deserves the same beat.)
    private static let visibleActionDelay: TimeInterval = 0.1

    static func decision(
        targetPid: pid_t?,
        frontmostPid: pid_t?,
        overlayRequested: Bool,
        targetWindowExposed: Bool
    ) -> Decision {
        guard overlayRequested,
              let targetPid,
              targetPid > 0 else {
            return Decision(visible: false, actionDelay: 0)
        }
        let isForeground = frontmostPid == targetPid
        guard isForeground || targetWindowExposed else {
            return Decision(visible: false, actionDelay: 0)
        }
        return Decision(
            visible: true,
            actionDelay: visibleActionDelay
        )
    }

    /// Pure core of the exposure test: walk the window list FRONT-TO-BACK
    /// (CGWindowList order), find the first ordinary window (layer 0 — skips
    /// our own high-level overlay panels, the menu bar, Dock, and the desktop)
    /// containing the point, and report its owner. `nil` when the point is
    /// over no ordinary window (empty desktop).
    static func firstOrdinaryWindowOwner(
        at point: CGPoint,
        in windowList: [[CFString: Any]]
    ) -> pid_t? {
        for info in windowList {
            guard let layer = info[kCGWindowLayer] as? Int, layer == 0 else {
                continue
            }
            guard let bounds = info[kCGWindowBounds] as? [String: CGFloat] else {
                continue
            }
            let rect = CGRect(
                x: bounds["X"] ?? 0,
                y: bounds["Y"] ?? 0,
                width: bounds["Width"] ?? 0,
                height: bounds["Height"] ?? 0
            )
            guard !rect.isEmpty, rect.contains(point) else { continue }
            guard let owner = info[kCGWindowOwnerPID] as? pid_t else { continue }
            return owner
        }
        return nil
    }
}

/// Live exposure evidence with a short TTL cache. The window list is a window-
/// server round trip; the cursor's display link re-evaluates policy every
/// frame, and 150ms of staleness is invisible next to the ~1s action cadence.
///
/// Coordinate contract: points are GLOBAL TOP-LEFT (Quartz/logical) — the same
/// space as `kCGWindowBounds`, action coordinates, and screenshots.
@MainActor
enum WindowExposure {
    static let cacheTTL: TimeInterval = 0.15

    private struct CacheEntry {
        let pid: pid_t
        let point: CGPoint
        let exposed: Bool
        let readAt: TimeInterval
    }

    private static var cache: CacheEntry?

    static func targetWindowExposed(
        at point: CGPoint,
        targetPid: pid_t,
        now: TimeInterval = ProcessInfo.processInfo.systemUptime,
        windowList: () -> [[CFString: Any]]? = systemWindowList
    ) -> Bool {
        if let cache,
           cache.pid == targetPid,
           cache.point == point,
           now - cache.readAt < cacheTTL {
            return cache.exposed
        }
        // Fail closed: an unreadable window list yields "not exposed", never a
        // cursor floating over unknown content.
        let exposed = windowList().map {
            OverlayPolicy.firstOrdinaryWindowOwner(at: point, in: $0) == targetPid
        } ?? false
        cache = CacheEntry(pid: targetPid, point: point, exposed: exposed, readAt: now)
        return exposed
    }

    static func resetForTests() { cache = nil }

    /// Front-to-back on-screen windows from the window server. Bounds and
    /// owner PIDs need no TCC grant (window NAMES would need Screen Recording,
    /// and we never read them here). `nonisolated`: a thread-safe C call, and
    /// isolating it would poison the non-isolated default-argument position.
    private nonisolated static func systemWindowList() -> [[CFString: Any]]? {
        CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[CFString: Any]]
    }
}

/// Pure lifecycle state used by the glow to distinguish transient visual hiding
/// from terminal tracker teardown.
struct OverlayLifecycleState: Equatable, Sendable {
    private enum Phase: Equatable, Sendable {
        case inactive
        case trackingHidden
        case trackingVisible
    }

    private var phase: Phase = .inactive

    var isActive: Bool { phase != .inactive }
    var isVisible: Bool { phase == .trackingVisible }

    mutating func startTracking() {
        phase = .trackingHidden
    }

    mutating func showWindow() {
        guard isActive else { return }
        phase = .trackingVisible
    }

    mutating func hideWindow() {
        guard isActive else { return }
        phase = .trackingHidden
    }

    mutating func stopTracking() {
        phase = .inactive
    }
}
