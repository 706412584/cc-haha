import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// A minimized app produced a real screenshot, a real accessibility tree, and
/// "Action completed" for every click and keystroke of an entire session, while
/// nothing whatsoever happened. Two separate defects combined to hide it:
/// capture accepts off-screen windows, actuation cannot use them, and the gap
/// between the two was a silent fallback to an unbound event that custom
/// renderers discard.
///
/// These tests hold both halves of the fix in place: the refusal, and the fact
/// that the model is told why.
final class OffScreenTargetTests: XCTestCase {
    private let point = CGPoint(x: 410, y: 50)

    private func windowList(
        pid: pid_t,
        bounds: CGRect,
        layer: Int = 0
    ) -> () -> [[CFString: Any]]? {
        {
            [[
                kCGWindowLayer: layer,
                kCGWindowNumber: 4242,
                kCGWindowOwnerPID: pid,
                kCGWindowBounds: [
                    "X": bounds.minX,
                    "Y": bounds.minY,
                    "Width": bounds.width,
                    "Height": bounds.height,
                ] as [String: CGFloat],
            ]]
        }
    }

    // MARK: - The distinction that was missing

    func testAnAppWithNoOnScreenWindowIsReportedAsOffScreen() {
        // The whole failure: the window server lists on-screen windows only, so
        // a minimized target simply is not there. Reported as "your coordinate
        // missed", the model retries other coordinates forever.
        let result = WindowGeometry.binding(at: point, pid: 501, windowList: { [] })
        XCTAssertEqual(result, .failure(.noWindowOnScreen))
    }

    func testAMissedCoordinateIsNotReportedAsOffScreen() {
        // The app IS on screen; the point just falls outside its window. Here
        // re-reading coordinates is exactly the right move, so the two cases
        // must not collapse into one message.
        let result = WindowGeometry.binding(
            at: point,
            pid: 501,
            windowList: windowList(pid: 501, bounds: CGRect(x: 800, y: 400, width: 300, height: 200))
        )
        XCTAssertEqual(result, .failure(.pointOutsideWindows))
    }

    func testAWindowUnderThePointBinds() {
        let result = WindowGeometry.binding(
            at: point,
            pid: 501,
            windowList: windowList(pid: 501, bounds: CGRect(x: 0, y: 0, width: 1000, height: 800))
        )
        XCTAssertEqual(try? result.get().id, 4242)
    }

    func testAnotherAppsWindowUnderThePointDoesNotCount() {
        // Binding an event to a window the target does not own addresses it to
        // the wrong process, which is worse than refusing.
        let result = WindowGeometry.binding(
            at: point,
            pid: 501,
            windowList: windowList(pid: 999, bounds: CGRect(x: 0, y: 0, width: 1000, height: 800))
        )
        XCTAssertEqual(result, .failure(.noWindowOnScreen))
    }

    func testOverlayLayersDoNotMakeAnAppLookReachable() {
        // Layer 0 only. An app whose only surface is a panel or overlay cannot
        // receive an app-directed click, so it is off screen for our purposes.
        XCTAssertFalse(
            WindowGeometry.hasWindowOnScreen(
                pid: 501,
                windowList: windowList(
                    pid: 501,
                    bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
                    layer: 25
                )
            )
        )
    }

    func testAZeroSizedWindowDoesNotCountAsOnScreen() {
        XCTAssertFalse(
            WindowGeometry.hasWindowOnScreen(
                pid: 501,
                windowList: windowList(pid: 501, bounds: .zero)
            )
        )
    }

    // MARK: - What the model is told

    func testTheModelIsToldWhenTheTargetCannotBeActedOn() {
        let notice = OffScreenTargetAdvice.noticeIfUnreachable(hasWindowOnScreen: false)
        XCTAssertNotNil(notice)
        // The model's instinct on a dead click is to try different coordinates.
        // Against an off-screen window that is an infinite loop, so the notice
        // has to close it explicitly rather than merely describe the state.
        XCTAssertTrue(notice!.contains("no window on screen"))
        XCTAssertTrue(notice!.contains("Do not retry with different coordinates"))
        // And it must name the way out, or the model has nothing to do next.
        XCTAssertTrue(notice!.contains("ask the user to bring it"))
    }

    func testTheNoticeKeepsElementActionsOpen() {
        // Only coordinate actuation needs on-screen geometry — it is the only
        // half that hit-tests. Element actions address a node directly and work
        // on a window in the Dock, which IS the background automation this
        // feature exists to provide.
        //
        // The first draft of this notice said "NOTHING can be clicked or typed".
        // That reads as a tidy warning and is a capability switch: the model
        // would stop at the exact moment it should reach for element_index.
        let notice = try! XCTUnwrap(
            OffScreenTargetAdvice.noticeIfUnreachable(hasWindowOnScreen: false)
        )
        XCTAssertTrue(notice.contains("Element actions still work"))
        for tool in ["element_index", "set_value", "select_text", "perform_secondary_action"] {
            XCTAssertTrue(notice.contains(tool), "\(tool) must be named as still usable")
        }
        // And it must not overclaim in the other direction either: a shell tree
        // has no elements to address, so that case needs its own sentence.
        XCTAssertTrue(notice.contains("bare shell"))
    }

    func testNothingIsSaidWhenTheTargetIsReachable() {
        // Every get_app_state carries this check; a notice on the normal path
        // would be noise in every single turn.
        XCTAssertNil(OffScreenTargetAdvice.noticeIfUnreachable(hasWindowOnScreen: true))
    }
}
