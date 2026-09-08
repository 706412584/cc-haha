import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// TCC-free display + window geometry.
///
/// Everything here is pure CoreGraphics (`CGGetActiveDisplayList`,
/// `CGDisplayBounds`, `CGDisplayPixelsWide`, `CGWindowListCopyWindowInfo`) plus
/// `NSWorkspace` for bundle-id → owner-name resolution. NONE of it needs Screen
/// Recording: display bounds and on-screen window *geometry* are visible without
/// the TCC grant (only window *titles* and pixel capture require it, and we read
/// neither here). This is why `get_display_size` / `list_displays` /
/// `find_window_displays` keep working when Screen Recording is denied.
///
/// The numbers are produced to match `runtime/mac_helper.py` byte-for-byte so
/// the TS `normalizeDisplayGeometry` layer (which falls back `id <- displayId`
/// and `label <- name`) sees an identical shape from either backend:
///   - `scaleFactor` = physical pixels wide / logical points wide
///   - `isPrimary`   = display is `CGMainDisplayID()` or `CGDisplayIsMain`
///   - `name`/`label` = "Display N" (1-based, enumeration order)
///   - window intersection uses `CGRectIntersection` against each display bounds
public enum Displays {
    /// Max displays to enumerate. macOS supports far fewer in practice; 32 is the
    /// same generous cap `mac_helper.py` uses for the two-call count pattern.
    private static let maxDisplays = 32

    // MARK: - Public API

    /// All active displays, in `CGGetActiveDisplayList` order (index drives the
    /// "Display N" name). Returns `[]` only if the enumeration call fails — a
    /// machine with zero active displays is not a normal runtime state.
    public static func list() -> [DisplayGeometry] {
        let ids = activeDisplayIDs()
        guard !ids.isEmpty else { return [] }
        let mainID = CGMainDisplayID()
        return ids.enumerated().map { index, displayID in
            geometry(for: displayID, index: index, mainID: mainID)
        }
    }

    /// Geometry for one display. `nil` → the primary display (the one flagged
    /// `isPrimary`, else the first enumerated). An unknown id throws
    /// `CUError("display_not_found", …)` — matching the Python
    /// `choose_display` `RuntimeError("Unknown display: …")` contract, but typed.
    public static func get(_ displayId: Int?) throws -> DisplayGeometry {
        let displays = list()
        guard !displays.isEmpty else {
            throw CUError("display_not_found", "No active displays found")
        }
        guard let displayId else {
            return displays.first(where: { $0.isPrimary }) ?? displays[0]
        }
        if let match = displays.first(where: { $0.displayId == displayId || $0.id == displayId }) {
            return match
        }
        throw CUError("display_not_found", "Unknown display: \(displayId)")
    }

    /// For each requested bundle id, which displays currently host one of its
    /// windows. Resolves bundle id → on-screen owner name (via
    /// `NSWorkspace.runningApplications`, falling back to the bundle id itself),
    /// then intersects every matching window rect against every display's bounds.
    ///
    /// Empty `bundleIds` → `[]` (mirrors `mac_helper.py`). The result preserves
    /// the input order and always contains one entry per requested bundle id,
    /// with `displayIds` sorted ascending. TCC-free: window *bounds* are visible
    /// without Screen Recording even though window *titles* are not.
    public static func findWindowDisplays(bundleIds: [String]) -> [WindowDisplays] {
        guard !bundleIds.isEmpty else { return [] }
        let displays = list()
        let windows = onScreenWindows()
        let nameByBundle = ownerNames(for: bundleIds)

        return bundleIds.map { bundleId in
            // `ownerNames` always supplies a value (it falls back to the bundle
            // id), so `targetName` is the string we match window owners against.
            let targetName = nameByBundle[bundleId] ?? bundleId
            var displayIds = Set<Int>()
            for window in windows where !window.ownerName.isEmpty {
                guard window.ownerName == targetName else { continue }
                for display in displays {
                    let displayRect = CGRect(
                        x: CGFloat(display.originX),
                        y: CGFloat(display.originY),
                        width: CGFloat(display.width),
                        height: CGFloat(display.height)
                    )
                    let hit = window.bounds.intersection(displayRect)
                    // `CGRectIntersection` returns a null rect on no overlap;
                    // a zero-area (edge-touching) overlap must not count, exactly
                    // like the Python `> 0` width/height guard.
                    if !hit.isNull, hit.width > 0, hit.height > 0 {
                        displayIds.insert(display.displayId)
                    }
                }
            }
            return WindowDisplays(bundleId: bundleId, displayIds: displayIds.sorted())
        }
    }

    // MARK: - Shared helper (Apps / Injection / Capture use this for hit-testing)

    /// On-screen, normal-layer application windows, front-to-back in
    /// `CGWindowListCopyWindowInfo` order (the system's z-order). Used by `Apps`
    /// (`app_under_point`, `frontmost` fallbacks) and `Injection`
    /// (coordinate → target-pid hit-testing) as well as `findWindowDisplays`.
    ///
    /// Filtering matches `mac_helper.py.list_windows()`:
    ///   - `kCGWindowLayer == 0` only (drop menu bar, Dock, overlays, our own
    ///     shielding-level cursor/glow windows, status items, etc.)
    ///   - on-screen only (`kCGWindowIsOnscreen`, default true when absent)
    ///   - width > 1 AND height > 1 (drop 1px tracking/utility slivers)
    ///
    /// `bounds` are in **global Quartz coordinates** (top-left origin, y-down) —
    /// the same space as `CGDisplayBounds` and the logical coordinates the TS
    /// layer sends, so callers can hit-test without any flip.
    static func onScreenWindows() -> [(ownerPID: pid_t, ownerName: String, bounds: CGRect, layer: Int)] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard
            let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
        else {
            return []
        }

        var out: [(ownerPID: pid_t, ownerName: String, bounds: CGRect, layer: Int)] = []
        out.reserveCapacity(raw.count)

        for window in raw {
            let layer = (window[kCGWindowLayer as String] as? Int) ?? 0
            if layer != 0 { continue }

            // Absent key means on-screen (Python uses default True).
            if let onScreen = window[kCGWindowIsOnscreen as String] as? Bool, !onScreen {
                continue
            }

            guard
                let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
                let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else {
                continue
            }
            if bounds.width <= 1 || bounds.height <= 1 { continue }

            let pid = pid_t((window[kCGWindowOwnerPID as String] as? Int) ?? 0)
            let ownerName = (window[kCGWindowOwnerName as String] as? String) ?? ""

            out.append((ownerPID: pid, ownerName: ownerName, bounds: bounds, layer: layer))
        }
        return out
    }

    // MARK: - Internals

    /// Two-call `CGGetActiveDisplayList` pattern: ask for the count, then fill an
    /// exactly-sized buffer. We use the fixed `maxDisplays` cap (like the Python)
    /// rather than a true two-pass so the single call both counts and fills.
    private static func activeDisplayIDs() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        // First call: discover how many active displays exist.
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
            return []
        }
        let cap = min(count, UInt32(maxDisplays))
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(cap))
        var filled: UInt32 = 0
        // Second call: fill the exactly-sized buffer.
        guard CGGetActiveDisplayList(cap, &ids, &filled) == .success else {
            return []
        }
        return Array(ids.prefix(Int(filled)))
    }

    /// Build one `DisplayGeometry`. `index` is the 0-based enumeration position
    /// (drives the 1-based "Display N" name); `mainID` is passed in so a list
    /// build resolves `CGMainDisplayID()` once.
    private static func geometry(
        for displayID: CGDirectDisplayID,
        index: Int,
        mainID: CGDirectDisplayID
    ) -> DisplayGeometry {
        let bounds = CGDisplayBounds(displayID)
        let logicalWidth = Int(bounds.size.width)
        let logicalHeight = Int(bounds.size.height)

        // Physical pixels wide: prefer the current display mode's pixel width
        // (authoritative for HiDPI/Retina, e.g. a scaled "looks like 1440" mode),
        // falling back to CGDisplayPixelsWide when no mode is available —
        // identical precedence to mac_helper.py. Only the *width* feeds
        // scaleFactor (matching the Python `physical_width / logical_width`), so
        // we deliberately don't compute a physical height here.
        var physicalWidth = Int(CGDisplayPixelsWide(displayID))
        if let mode = CGDisplayCopyDisplayMode(displayID), mode.pixelWidth > 0 {
            physicalWidth = mode.pixelWidth
        }

        let scaleFactor: Double = logicalWidth > 0
            ? Double(physicalWidth) / Double(logicalWidth)
            : 1.0

        let isPrimary = (displayID == mainID) || (CGDisplayIsMain(displayID) != 0)
        let name = "Display \(index + 1)"

        return DisplayGeometry(
            id: Int(displayID),
            displayId: Int(displayID),
            width: logicalWidth,
            height: logicalHeight,
            scaleFactor: scaleFactor,
            originX: Int(bounds.origin.x),
            originY: Int(bounds.origin.y),
            isPrimary: isPrimary,
            name: name,
            label: name
        )
    }

    /// Resolve each bundle id to the display name we expect its on-screen windows
    /// to carry as `kCGWindowOwnerName`. Primary source is the live running app's
    /// `localizedName` (what the window server reports as the owner); fallback is
    /// the bundle id itself so an unmatched id still filters deterministically —
    /// the same two-step fallback as `mac_helper.py.app_display_name` (minus the
    /// installed-apps scan, which doesn't help here: an app with no *running*
    /// process has no on-screen windows to intersect anyway).
    private static func ownerNames(for bundleIds: [String]) -> [String: String] {
        let running = NSWorkspace.shared.runningApplications
        var localizedByBundle: [String: String] = [:]
        for app in running {
            guard let bundle = app.bundleIdentifier else { continue }
            // First running instance wins (matches the Python loop order).
            if localizedByBundle[bundle] == nil {
                localizedByBundle[bundle] = app.localizedName ?? bundle
            }
        }

        var result: [String: String] = [:]
        result.reserveCapacity(bundleIds.count)
        for bundleId in bundleIds {
            result[bundleId] = localizedByBundle[bundleId] ?? bundleId
        }
        return result
    }
}
