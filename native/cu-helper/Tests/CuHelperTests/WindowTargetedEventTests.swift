import AppKit
import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// These guard the fix for the defect that made Computer Use useless on every
/// Electron/CEF app: a bare `CGEvent` carries no window identity, and
/// Chromium routes input by the window an event claims, so clicks and
/// keystrokes were dropped while the helper reported "Action completed".
final class WindowTargetedEventTests: XCTestCase {

    // MARK: Window-local coordinates

    /// Top-left origin, NOT flipped. Verified against a live CEF window: a
    /// top-left-relative local point lands where the same global point does,
    /// while flipping it hit the opposite edge (a click meant for the search
    /// field opened the player at the window's bottom).
    func testWindowLocalPointIsTopLeftRelativeAndUnflipped() {
        let bounds = CGRect(x: 299, y: -1107, width: 1061, height: 1084)
        let local = WindowTargetedEvent.windowLocalPoint(
            globalPoint: CGPoint(x: 709, y: -1058),
            windowBounds: bounds
        )
        XCTAssertEqual(local.x, 410, accuracy: 0.0001)
        XCTAssertEqual(local.y, 49, accuracy: 0.0001, "flipping here aims at the wrong edge")
    }

    /// Windows on displays above/left of the primary have negative origins;
    /// the subtraction must stay pure arithmetic with no clamping.
    func testNegativeWindowOriginsAreHandled() {
        let local = WindowTargetedEvent.windowLocalPoint(
            globalPoint: CGPoint(x: -100, y: -200),
            windowBounds: CGRect(x: -500, y: -600, width: 800, height: 600)
        )
        XCTAssertEqual(local.x, 400, accuracy: 0.0001)
        XCTAssertEqual(local.y, 400, accuracy: 0.0001)
    }

    // MARK: Event numbers

    /// AppKit collapses a burst into one event when the event numbers repeat,
    /// so a double-click would register as a single click.
    func testEventNumbersAreStrictlyIncreasing() {
        let numbers = (0..<64).map { _ in WindowTargetedEvent.nextEventNumber() }
        XCTAssertEqual(numbers, numbers.sorted())
        XCTAssertEqual(Set(numbers).count, numbers.count)
        XCTAssertTrue(numbers.allSatisfy { $0 > 0 })
    }

    // MARK: Event construction

    /// The whole point: the built event must carry the window number and both
    /// window-under-pointer fields — those are what route it.
    func testMouseEventCarriesWindowIdentity() throws {
        let windowID: CGWindowID = 5799
        let event = try XCTUnwrap(
            WindowTargetedEvent.makeMouseEvent(
                type: .leftMouseDown,
                nsType: .leftMouseDown,
                point: CGPoint(x: 709, y: -1058),
                button: .left,
                clickCount: 1,
                windowID: windowID,
                windowBounds: CGRect(x: 299, y: -1107, width: 1061, height: 1084)
            )
        )

        // NX_SUBTYPE_MOUSE_TOUCH, matching the reference implementation.
        // A single-variable A/B on a live CEF target showed actuation still
        // works without it, so this asserts what we send, not a requirement.
        XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 7)!), 3)
        XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 91)!), Int64(windowID))
        XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 92)!), Int64(windowID))

        let roundTripped = try XCTUnwrap(NSEvent(cgEvent: event))
        XCTAssertEqual(
            roundTripped.windowNumber,
            Int(windowID),
            "window number must survive the NSEvent → CGEvent bridge; it is the routing key"
        )
    }

    /// An unknown window must not be stamped as window 0 — addressing an event
    /// to a window the target does not own guarantees it is dropped. The event
    /// is still produced so actuation degrades to the old behaviour.
    func testUnknownWindowLeavesTargetingFieldsUnset() throws {
        let event = try XCTUnwrap(
            WindowTargetedEvent.makeMouseEvent(
                type: .leftMouseDown,
                nsType: .leftMouseDown,
                point: CGPoint(x: 10, y: 10),
                button: .left,
                clickCount: 1,
                windowID: kCGNullWindowID,
                windowBounds: nil
            )
        )
        XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 91)!), 0)
        XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 92)!), 0)
    }

    /// The private window-location SPI must be resolvable on this OS; losing it
    /// silently would degrade every CEF click back to the broken behaviour.
    func testWindowLocationSPIResolves() {
        XCTAssertTrue(
            WindowTargetedEvent.canStampWindowLocation,
            "CGEventSetWindowLocation missing — CEF targeting degrades"
        )
    }

    // MARK: CGEventType → NSEvent.EventType

    /// Every mouse type actuation emits must have a window-bound form, or that
    /// action silently falls back to the broken path.
    func testAllActuatedMouseTypesMap() {
        let required: [CGEventType] = [
            .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp,
            .mouseMoved,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
        ]
        for type in required {
            XCTAssertNotNil(Injection.nsEventType(for: type), "no NSEvent type for \(type)")
        }
        // Keyboard has no window-bound mouse form; it must not be coerced.
        XCTAssertNil(Injection.nsEventType(for: .keyDown))
        XCTAssertNil(Injection.nsEventType(for: .scrollWheel))
    }
}

/// The window lookup that supplies the targeting identity.
final class WindowGeometryTests: XCTestCase {
    private func info(
        layer: Int,
        x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat,
        number: Int,
        pid: pid_t
    ) -> [CFString: Any] {
        [
            kCGWindowLayer: layer,
            kCGWindowNumber: number,
            kCGWindowOwnerPID: pid,
            kCGWindowBounds: ["X": x, "Y": y, "Width": w, "Height": h] as [String: CGFloat],
        ]
    }

    func testFrontmostOrdinaryWindowContainingThePointWins() {
        let list = [
            info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 1, pid: 7),
            info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 2, pid: 8),
        ]
        let window = WindowGeometry.window(at: CGPoint(x: 10, y: 10)) { list }
        XCTAssertEqual(window?.id, 1)
        XCTAssertEqual(window?.ownerPid, 7)
    }

    /// Restricting to the actuation target keeps another app's floating panel
    /// from claiming the binding — that would address the event to a window the
    /// target does not own, i.e. drop it.
    func testPidFilterIgnoresOtherAppsWindows() {
        let list = [
            info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 1, pid: 7),
            info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 2, pid: 8),
        ]
        XCTAssertEqual(WindowGeometry.window(at: CGPoint(x: 10, y: 10), pid: 8) { list }?.id, 2)
        XCTAssertNil(WindowGeometry.window(at: CGPoint(x: 10, y: 10), pid: 99) { list })
    }

    /// Non-zero layers (overlays, menu bar, Dock) cannot receive an
    /// app-directed click — including our own virtual-cursor panels, which
    /// would otherwise shadow every target.
    func testNonZeroLayersAreSkipped() {
        let list = [
            info(layer: 25, x: 0, y: 0, w: 100, h: 100, number: 1, pid: 7),
            info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 2, pid: 8),
        ]
        XCTAssertEqual(WindowGeometry.window(at: CGPoint(x: 10, y: 10)) { list }?.id, 2)
    }

    func testPointOutsideEveryWindowHasNoOwner() {
        let list = [info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 1, pid: 7)]
        XCTAssertNil(WindowGeometry.window(at: CGPoint(x: 500, y: 500)) { list })
    }

    /// Negative-origin windows (displays above/left of primary) must resolve —
    /// the multi-display case is exactly where this feature is used.
    func testNegativeOriginWindowsResolve() {
        let list = [info(layer: 0, x: -500, y: -600, w: 800, h: 600, number: 3, pid: 7)]
        XCTAssertEqual(WindowGeometry.window(at: CGPoint(x: -100, y: -200)) { list }?.id, 3)
    }

    /// Malformed or zero-sized window-server entries are skipped, not trusted.
    func testMalformedEntriesAreSkipped() {
        let list: [[CFString: Any]] = [
            [kCGWindowLayer: 0],
            info(layer: 0, x: 0, y: 0, w: 0, h: 0, number: 1, pid: 7),
            info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 2, pid: 7),
        ]
        XCTAssertEqual(WindowGeometry.window(at: CGPoint(x: 5, y: 5)) { list }?.id, 2)
    }

    func testUnreadableWindowListYieldsNoWindow() {
        XCTAssertNil(WindowGeometry.window(at: .zero) { nil })
    }

    func testExactWindowIdentityRevalidationKeepsOriginalWindowAfterMoveAndReorder() throws {
        var list = [info(layer: 0, x: -500, y: -600, w: 800, h: 600, number: 3, pid: 7)]
        let original = try XCTUnwrap(WindowGeometry.window(
            at: CGPoint(x: -100, y: -200), pid: 7, windowList: { list }
        ))

        // During an async action another window takes the old position while
        // the original moves. Revalidation must not switch to that new window.
        list = [
            info(layer: 0, x: -500, y: -600, w: 800, h: 600, number: 4, pid: 7),
            info(layer: 0, x: 100, y: 200, w: 900, h: 700, number: 3, pid: 7),
        ]
        let current = try XCTUnwrap(WindowGeometry.window(
            id: original.id, pid: original.ownerPid, windowList: { list }
        ))

        XCTAssertEqual(current.id, original.id)
        XCTAssertEqual(current.ownerPid, original.ownerPid)
        XCTAssertEqual(current.bounds, CGRect(x: 100, y: 200, width: 900, height: 700))
        XCTAssertNotEqual(current.bounds, original.bounds)
    }

    func testExactWindowIdentityRequiresMatchingNumberOwnerAndOrdinaryLayer() {
        let candidates = [
            info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 4, pid: 7),
            info(layer: 0, x: 0, y: 0, w: 100, h: 100, number: 3, pid: 8),
            info(layer: 25, x: 0, y: 0, w: 100, h: 100, number: 3, pid: 7),
        ]
        for candidate in candidates {
            XCTAssertNil(WindowGeometry.window(id: 3, pid: 7, windowList: { [candidate] }))
        }

        let valid = info(layer: 0, x: -10, y: -20, w: 100, h: 200, number: 3, pid: 7)
        XCTAssertEqual(
            WindowGeometry.window(id: 3, pid: 7, windowList: { candidates + [valid] }),
            WindowGeometry.Window(id: 3, bounds: CGRect(x: -10, y: -20, width: 100, height: 200), ownerPid: 7)
        )
    }

    func testExactWindowIdentityRejectsMissingEmptyAndNonfiniteBounds() {
        let validBounds: [String: CGFloat] = ["X": 10, "Y": 20, "Width": 100, "Height": 200]
        var cases: [(String, [String: CGFloat]?)] = [("missing bounds", nil)]
        for field in ["X", "Y", "Width", "Height"] {
            var missing = validBounds
            missing.removeValue(forKey: field)
            cases.append(("missing \(field)", missing))
            for invalid: CGFloat in [.nan, .infinity, -.infinity] {
                var bounds = validBounds
                bounds[field] = invalid
                cases.append(("\(field) = \(invalid)", bounds))
            }
        }
        for dimension in ["Width", "Height"] {
            for invalid: CGFloat in [0, -1] {
                var bounds = validBounds
                bounds[dimension] = invalid
                cases.append(("\(dimension) = \(invalid)", bounds))
            }
        }

        for (description, bounds) in cases {
            var candidate = info(layer: 0, x: 10, y: 20, w: 100, h: 200, number: 3, pid: 7)
            candidate[kCGWindowBounds] = bounds
            XCTAssertNil(
                WindowGeometry.window(id: 3, pid: 7, windowList: { [candidate] }),
                description
            )
        }
    }

    func testExactWindowIdentityDoesNotInventWindowWhenListIsUnavailable() {
        XCTAssertNil(WindowGeometry.window(id: 3, pid: 7, windowList: { nil }))
        XCTAssertNil(WindowGeometry.window(id: 3, pid: 7, windowList: { [] }))
    }
}

/// Guards the foreground-settle behaviour that makes background actuation
/// possible at all.
final class FocusSettleTests: XCTestCase {
    /// A target that already owns the foreground must not be re-focused, and
    /// must not pay the settle delay — that is the common case and it has to
    /// stay fast.
    func testAlreadyFrontmostTargetIsNotRefocused() {
        XCTAssertTrue(WindowKeyFocus.alreadyFrontmost(pid: 42, frontmostPid: 42))
        XCTAssertFalse(WindowKeyFocus.alreadyFrontmost(pid: 42, frontmostPid: 7))
        XCTAssertFalse(WindowKeyFocus.alreadyFrontmost(pid: 42, frontmostPid: nil))
    }

    /// Invalid targets must never reach the focus SPI: a zero/negative pid or a
    /// null window would ask the window server to front something unnamed.
    func testInvalidTargetsAreRefusedBeforeTheSPI() {
        XCTAssertFalse(WindowKeyFocus.grant(pid: 0, windowID: 1))
        XCTAssertFalse(WindowKeyFocus.grant(pid: -1, windowID: 1))
        XCTAssertFalse(WindowKeyFocus.grant(pid: 42, windowID: kCGNullWindowID))
    }

    /// The focus SPI must resolve on this OS. Without it a background target
    /// can never be clicked — actuation degrades to foreground-only silently.
    func testFocusSPIResolves() {
        XCTAssertTrue(
            WindowKeyFocus.isAvailable,
            "CPS focus SPI missing — background clicks degrade to no-ops"
        )
    }
}
