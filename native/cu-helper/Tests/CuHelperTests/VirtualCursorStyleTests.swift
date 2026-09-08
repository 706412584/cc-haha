import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// The arrow's contract is geometric, and one property carries the whole point
/// of having a pointer at all: the TIP must sit exactly at the origin, because
/// the layer's `position` is set to the pixel being acted on. If the tip drifts
/// off (0,0), the cursor visibly points somewhere the click will not land —
/// which is worse than no cursor, since the user would trust it.
final class VirtualCursorStyleTests: XCTestCase {
    func testTipSitsExactlyAtTheOrigin() {
        let box = VirtualCursorStyle.arrowPath().boundingBox
        XCTAssertEqual(box.minX, 0, accuracy: 0.0001)
        XCTAssertEqual(box.minY, 0, accuracy: 0.0001)
    }

    /// Scaling must not move the hot-spot or distort the aspect ratio — the
    /// silhouette has to stay recognisably the system pointer at any size.
    func testScalesAboutTheTipKeepingAspectRatio() {
        let small = VirtualCursorStyle.arrowPath(height: 11).boundingBox
        let large = VirtualCursorStyle.arrowPath(height: 44).boundingBox

        XCTAssertEqual(small.minX, 0, accuracy: 0.0001)
        XCTAssertEqual(large.minX, 0, accuracy: 0.0001)
        XCTAssertEqual(large.height / small.height, 4, accuracy: 0.01)
        XCTAssertEqual(
            large.width / small.width,
            4,
            accuracy: 0.01,
            "width must scale with height or the arrow skews"
        )
    }

    /// A pointer is taller than it is wide; a shape that fails this is a blob,
    /// not an arrow — which is exactly the regression this file exists to stop.
    func testSilhouetteIsPointerShapedNotRound() {
        let box = VirtualCursorStyle.arrowPath().boundingBox
        XCTAssertGreaterThan(box.height, box.width)
        XCTAssertLessThan(box.width / box.height, 0.8)
    }

    /// The path must actually enclose area just below the tip — a degenerate or
    /// mis-ordered polygon can still pass a bounding-box check while rendering
    /// as nothing.
    func testPathEnclosesAreaBeneathTheTip() {
        let path = VirtualCursorStyle.arrowPath()
        XCTAssertTrue(path.contains(CGPoint(x: 2, y: 6)))
        // Far to the right of the shoulder is outside the silhouette.
        XCTAssertFalse(path.contains(CGPoint(x: 20, y: 2)))
    }

    /// Arrow is the default; the orb is opt-in. Codex ships both, but only one
    /// of them can point at a pixel.
    func testArrowIsTheDefaultStyle() {
        XCTAssertEqual(VirtualCursorStyle(rawValue: "arrow"), .arrow)
        XCTAssertEqual(VirtualCursorStyle(rawValue: "fog"), .fog)
        XCTAssertNil(VirtualCursorStyle(rawValue: "orb"))
    }

    /// The idle motions exist because a model turn freezes the screen for 8–14
    /// seconds and a still cursor cannot be told apart from a hung one. Their
    /// numbers are a balance, and both ends of it are worth failing over.
    func testIdleBobStaysTooSmallToMisstateTheClickPoint() {
        // The tip is a promise about which pixel is about to be clicked. A bob
        // large enough to read as aim breaks that promise for the sake of a
        // decoration — the exact trade this constant exists to prevent.
        XCTAssertLessThanOrEqual(VirtualCursorStyle.idleBobAmplitude, 2.0)
        // ...but zero is not "subtle", it is the frozen cursor we started with.
        XCTAssertGreaterThan(VirtualCursorStyle.idleBobAmplitude, 0.5)
    }

    func testHaloIsUnmistakablyLargerThanTheSilhouette() {
        let box = VirtualCursorStyle.arrowPath().boundingBox
        let diameter = VirtualCursorStyle.haloDiameter(forArrowHeight: box.maxY)
        // A halo that only just clears the outline reads as a rendering
        // artefact — a fringe — rather than a deliberate aura.
        XCTAssertGreaterThan(diameter, box.height * 1.5)
        // And one that swallows the screen stops being a cursor.
        XCTAssertLessThan(diameter, box.height * 4)
    }

    func testHaloScalesWithTheArrow() {
        // Both are driven off one height so a resized cursor keeps its
        // proportions instead of growing a fixed-size blob.
        let small = VirtualCursorStyle.haloDiameter(forArrowHeight: 11)
        let large = VirtualCursorStyle.haloDiameter(forArrowHeight: 44)
        XCTAssertEqual(large / small, 4, accuracy: 0.01)
    }

    func testBreathAndBobDoNotSharePhase() {
        // Two motions locked to one beat read as a single mechanical pulse; the
        // point of having both is that they drift against each other.
        let bob = VirtualCursorStyle.idleBobPeriod
        let breath = VirtualCursorStyle.haloBreathPeriod
        XCTAssertNotEqual(bob, breath)
        let ratio = max(bob, breath) / min(bob, breath)
        XCTAssertNotEqual(ratio, ratio.rounded(), accuracy: 0.05)
    }

    func testIdlePeriodsStayInTheCalmRange() {
        // Fast enough to read as alive, slow enough not to nag: anything under
        // a second is a twitch, anything over four reads as frozen again.
        for period in [VirtualCursorStyle.idleBobPeriod,
                       VirtualCursorStyle.haloBreathPeriod] {
            XCTAssertGreaterThan(period, 1.0)
            XCTAssertLessThan(period, 4.0)
        }
    }
}
