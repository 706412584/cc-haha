import CoreGraphics
import Foundation

/// Which look the AI's virtual cursor wears.
///
/// Codex ships the same two (`SoftwareCursorStyle` = `arrow` | `fog`). We
/// default to `.arrow`: a cursor exists to point at a pixel, and a round blob
/// has no tip to point with — it cannot show *where* the click will land, and
/// it does not read as a mouse pointer. The orb stays available because it is
/// unmistakably not the user's real pointer, which is the one thing it does
/// better.
public enum VirtualCursorStyle: String, Sendable {
    case arrow
    case fog

    /// Env override, mostly for demos and screenshots:
    /// `CU_HELPER_CURSOR_STYLE=fog`. Unknown values fall back to `.arrow`
    /// rather than failing — a cosmetic setting must never break actuation.
    public static var current: VirtualCursorStyle {
        guard let raw = ProcessInfo.processInfo.environment["CU_HELPER_CURSOR_STYLE"],
              let style = VirtualCursorStyle(rawValue: raw.lowercased()) else {
            return .arrow
        }
        return style
    }

    /// The classic macOS pointer silhouette, tip at the ORIGIN.
    ///
    /// Kept as a pure function so the geometry that matters — the tip sits
    /// exactly at (0,0), so `layer.position` is the acted-on pixel — is
    /// testable without a window server.
    ///
    /// - Parameter height: overall height in points.
    public static func arrowPath(height: CGFloat = 22) -> CGPath {
        // Reference outline in a 12 × 19 box (tip at 0,0, pointing down-right,
        // with the familiar notched tail), then scaled to `height`.
        let referenceHeight: CGFloat = 19
        let s = height / referenceHeight
        let points: [CGPoint] = [
            CGPoint(x: 0.0, y: 0.0),     // tip — the hot-spot
            CGPoint(x: 0.0, y: 16.5),    // left edge down
            CGPoint(x: 4.0, y: 12.7),    // notch inward
            CGPoint(x: 6.6, y: 18.5),    // tail outer
            CGPoint(x: 9.2, y: 17.4),    // tail inner
            CGPoint(x: 6.6, y: 11.6),    // back up to the shoulder
            CGPoint(x: 11.6, y: 11.2),   // right shoulder
        ]

        let path = CGMutablePath()
        for (index, p) in points.enumerated() {
            let scaled = CGPoint(x: p.x * s, y: p.y * s)
            if index == 0 { path.move(to: scaled) } else { path.addLine(to: scaled) }
        }
        path.closeSubpath()
        return path
    }

    // MARK: - Idle liveness
    //
    // A model turn spends 8–14 seconds thinking between actions; measured on a
    // real task, tool execution was 4% of wall clock and the rest was the model.
    // For all of that the screen is frozen, and a still cursor is
    // indistinguishable from a hung one. These two motions exist to say "still
    // working" without moving the pointer anywhere it is not.
    //
    // Both run as Core Animation animations on the render server, so they cost
    // nothing per frame in this process and need no timer of our own.

    /// Diameter of the soft glow behind the arrow, in points.
    ///
    /// Comfortably larger than the silhouette — a halo that only just clears the
    /// outline reads as a rendering artefact rather than a deliberate aura.
    public static func haloDiameter(forArrowHeight height: CGFloat = 22) -> CGFloat {
        height * 2.4
    }

    /// Peak vertical excursion of the idle bob, in points.
    ///
    /// Deliberately tiny. The arrow's tip is a claim about which pixel is about
    /// to be clicked, so the bob has to be visible as *life* without ever being
    /// readable as *aim*. Anything past a couple of points starts to look like
    /// the cursor is pointing somewhere it is not.
    public static let idleBobAmplitude: CGFloat = 1.5

    /// Seconds for one complete up-and-down cycle of the idle bob.
    public static let idleBobPeriod: Double = 1.8

    /// Seconds for one complete swell-and-fade cycle of the halo.
    ///
    /// Intentionally not a multiple of `idleBobPeriod`: two motions on a shared
    /// beat read as one mechanical pulse, while drifting phases read as
    /// something alive.
    public static let haloBreathPeriod: Double = 2.4
}
