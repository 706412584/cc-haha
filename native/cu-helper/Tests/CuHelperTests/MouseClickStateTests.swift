import CoreGraphics
import XCTest
@testable import cc_haha_computer_use

/// Regression cover for the field that decides whether a synthesized pointer
/// event counts as part of a click.
///
/// Background: the leading move of a coordinate click used to carry the repeat
/// count (1 for a single click, 2 for a double) instead of 0, so the target was
/// told "a pointer belonging to click N arrived" before any button went down.
/// Measured against an Electron target, single clicks then registered as hover
/// and never activated the control, while double clicks worked — the second
/// press/release pair got through. Nothing in the suite covered these fields,
/// which is why the value survived from the engine's first commit.
@MainActor
final class MouseClickStateTests: XCTestCase {
    private let movement: [CGEventType] = [
        .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
    ]
    private let transitions: [CGEventType] = [
        .leftMouseDown, .leftMouseUp,
        .rightMouseDown, .rightMouseUp,
        .otherMouseDown, .otherMouseUp,
    ]

    func testMovementNeverBelongsToAClick() {
        for type in movement {
            // Including the double-click case: it is the one that used to make
            // the leading move claim clickState 2.
            for click in 1...3 {
                XCTAssertEqual(
                    AXAction.mouseClickState(for: type, click: click),
                    0,
                    "movement event \(type.rawValue) must report clickState 0, not the click number"
                )
            }
        }
    }

    func testButtonTransitionsCarryTheirClickNumber() {
        for type in transitions {
            for click in 1...3 {
                XCTAssertEqual(
                    AXAction.mouseClickState(for: type, click: click),
                    click,
                    "press/release must carry the 1…N cadence a real multi-click reports"
                )
            }
        }
    }

    func testMovementClassification() {
        for type in movement {
            XCTAssertTrue(AXAction.isMovement(type), "\(type.rawValue) is pointer transport")
        }
        for type in transitions {
            XCTAssertFalse(AXAction.isMovement(type), "\(type.rawValue) is a button transition")
        }
        // Scroll is neither, and must not be mistaken for movement: it has no
        // click cadence but is also not a pointer transport event we synthesize
        // through this path.
        XCTAssertFalse(AXAction.isMovement(.scrollWheel))
    }

    /// A zero must survive all the way onto the NSEvent the CGEvent field is
    /// attached to. `AXAction.makeMouse` used to pass `max(1, clickState)` here,
    /// which re-raised movement to "click 1" — the CGEvent field then said 0
    /// while the event carrying it said 1.
    func testWindowBoundEventPreservesAZeroClickCount() throws {
        let event = try XCTUnwrap(
            WindowTargetedEvent.makeMouseEvent(
                type: .mouseMoved,
                nsType: .mouseMoved,
                point: CGPoint(x: 10, y: 20),
                button: .left,
                clickCount: 0,
                windowID: 4321,
                windowBounds: CGRect(x: 0, y: 0, width: 100, height: 100)
            )
        )

        XCTAssertEqual(
            event.getIntegerValueField(.mouseEventClickState),
            0,
            "a movement event must not be reported as belonging to a click"
        )
    }

    func testWindowBoundEventKeepsRealClickCounts() throws {
        for click in 1...3 {
            let event = try XCTUnwrap(
                WindowTargetedEvent.makeMouseEvent(
                    type: .leftMouseDown,
                    nsType: .leftMouseDown,
                    point: CGPoint(x: 10, y: 20),
                    button: .left,
                    clickCount: click,
                    windowID: 4321,
                    windowBounds: CGRect(x: 0, y: 0, width: 100, height: 100)
                )
            )
            XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), Int64(click))
        }
    }

    /// A press and the release that ends it must be tied together by a shared
    /// eventNumber — that pairing is how AppKit reads two events as one click.
    /// Each event used to take a fresh number, so the target got a press and a
    /// release it had no reason to associate. Measured symptom: a text field,
    /// which focuses on the press alone, accepted our clicks, while list rows
    /// and buttons — which need a complete click — did not.
    func testAPressAndItsReleaseCanShareANumber() throws {
        let shared = WindowTargetedEvent.nextEventNumber()
        var seen: [Int64] = []
        for nsType in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(
                WindowTargetedEvent.makeMouseEvent(
                    type: nsType == .leftMouseDown ? .leftMouseDown : .leftMouseUp,
                    nsType: nsType,
                    point: CGPoint(x: 5, y: 5),
                    button: .left,
                    clickCount: 1,
                    windowID: 77,
                    windowBounds: CGRect(x: 0, y: 0, width: 50, height: 50),
                    eventNumber: shared
                )
            )
            seen.append(event.getIntegerValueField(.mouseEventNumber))
        }
        XCTAssertEqual(seen.first, seen.last, "press and release must carry one number")
        XCTAssertEqual(seen.first, Int64(shared))
    }

    /// Omitting the number keeps the old behaviour for lone events, so a caller
    /// that has no gesture to tie together still gets a unique one.
    func testALoneEventStillTakesItsOwnNumber() throws {
        var seen: Set<Int64> = []
        for _ in 0..<3 {
            let event = try XCTUnwrap(
                WindowTargetedEvent.makeMouseEvent(
                    type: .leftMouseDown,
                    nsType: .leftMouseDown,
                    point: CGPoint(x: 5, y: 5),
                    button: .left,
                    clickCount: 1,
                    windowID: 77,
                    windowBounds: CGRect(x: 0, y: 0, width: 50, height: 50)
                )
            )
            seen.insert(event.getIntegerValueField(.mouseEventNumber))
        }
        XCTAssertEqual(seen.count, 3, "distinct events must not collide")
    }

    /// Source guard: both halves of a click must read the same variable. A
    /// per-event `nextEventNumber()` in the burst builder would compile, pass
    /// every field assertion above, and quietly restore the split pairing.
    func testClickBurstBindsPressAndReleaseToOneNumber() throws {
        let source = try String(
            contentsOfFile: sourcePath("AXAction.swift"),
            encoding: .utf8
        )
        let pairs = source.components(separatedBy: "eventNumber: clickNumber").count - 1
        XCTAssertEqual(
            pairs, 2,
            "the press and the release of a coordinate click must share one number"
        )
        let gesture = source.components(separatedBy: "eventNumber: gestureNumber").count - 1
        XCTAssertEqual(gesture, 2, "a drag's press and release must share one number")
    }

    /// Source guard: the floor is easy to reintroduce as "defensive" code, and
    /// it would silently undo every assertion above — the builders would keep
    /// asking for 0 and the event would keep saying 1.
    func testClickCountIsNotFlooredAtOne() throws {
        let source = try String(
            contentsOfFile: sourcePath("AXAction.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(
            source.contains("max(1, spec.clickState)"),
            "clickCount must be passed through; flooring it at 1 re-raises movement to click 1"
        )
    }

    private func sourcePath(_ name: String) -> String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // CuHelperTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
            .appendingPathComponent("Sources/cu-helper/\(name)")
            .path
    }
}
