import XCTest

/// Every synthetic mouse event the helper emits must go through the
/// window-bound builder.
///
/// This test exists because of a real, expensive failure: the window-targeting
/// fix was implemented in `Injection.makeMouse`, but a COORDINATE click never
/// goes through `Injection` — `CommandRouter.handleClick` calls
/// `AXAction.clickAtPoint`, which falls through to `AXAction.clickPoint`, which
/// had its **own** parallel event builder that was never updated. The product
/// shipped three times still broken while the tests were green, because the
/// tests only ever exercised the half that was fixed.
///
/// So this asserts on the SOURCE: no file may construct a raw mouse
/// `CGEvent(mouseEventSource:mouseType:…)` without also consulting
/// `WindowTargetedEvent` in the same file. A new call site that forgets the
/// window binding fails here rather than silently degrading on Chromium apps.
final class InjectionPathParityTests: XCTestCase {
    private func sourceFiles() throws -> [(name: String, text: String)] {
        // Tests run from the package root; walk to the sources directory.
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // CuHelperTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // cu-helper
            .appendingPathComponent("Sources/cu-helper")
        let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
        return try names.filter { $0.hasSuffix(".swift") }.map {
            ($0, try String(contentsOf: root.appendingPathComponent($0), encoding: .utf8))
        }
    }

    func testEveryRawMouseEventBuilderAlsoUsesWindowTargeting() throws {
        var offenders: [String] = []
        for file in try sourceFiles() {
            guard file.text.contains("mouseEventSource:") else { continue }
            // WindowTargetedEvent itself is the fallback of last resort.
            if file.name == "WindowTargetedEvent.swift" { continue }
            if !file.text.contains("WindowTargetedEvent") {
                offenders.append(file.name)
            }
        }
        XCTAssertEqual(
            offenders,
            [],
            "these build raw mouse events without window binding — Chromium/CEF apps will silently ignore them"
        )
    }

    /// A burst is allocated up front (so a mid-burst failure cannot strand a
    /// held button) but must carry SEND-time timestamps, so it has to be posted
    /// through the stamping helper rather than a bare `postToPid`.
    ///
    /// Scoped to loop bodies over an allocated `events` array. The held-input
    /// teardown paths post a single retained event on a cleanup path where a
    /// stale timestamp is harmless and re-stamping would obscure when the
    /// button was actually pressed.
    func testMouseBurstsPostThroughTheTimestampingHelper() throws {
        var offenders: [String] = []
        for file in try sourceFiles() where file.text.contains("mouseEventSource:") {
            if file.name == "WindowTargetedEvent.swift" { continue }
            let lines = file.text.split(separator: "\n", omittingEmptySubsequences: false)
            for (index, line) in lines.enumerated() {
                guard line.trimmingCharacters(in: .whitespaces) == "event.postToPid(pid)" else { continue }
                // Look back a few lines for the burst-loop signature.
                let window = lines[max(0, index - 3)..<index].joined(separator: " ")
                if window.contains("for event in events") {
                    offenders.append("\(file.name):\(index + 1)")
                }
            }
        }
        XCTAssertEqual(offenders, [], "post burst events via WindowTargetedEvent.post")
    }

    /// Coordinate actuation must REFUSE when it cannot name a window, never fall
    /// through to an unbound event.
    ///
    /// Same class of failure as the one above, one layer down. `makeMouse` used
    /// to resolve the window itself and, on failure, quietly build a raw event
    /// instead — which Chromium discards. Against a minimized target that made
    /// every click and every keystroke of a session a no-op that still reported
    /// "Action completed". The unbound builder is still there for callers that
    /// legitimately have no target, so the guarantee has to be that the
    /// coordinate entry points ask for a window first.
    func testCoordinateActuationRefusesWhenNoWindowCanBeNamed() throws {
        let axAction = try sourceFiles().first { $0.name == "AXAction.swift" }
        let text = try XCTUnwrap(axAction?.text, "AXAction.swift is missing")

        XCTAssertTrue(
            text.contains("requireBindableWindow"),
            "coordinate actuation must resolve a window through the throwing guard"
        )
        // Both coordinate entry points — a drag that silently degrades is the
        // same bug wearing a different verb.
        let guardedCalls = text.components(separatedBy: "try requireBindableWindow").count - 1
        XCTAssertGreaterThanOrEqual(
            guardedCalls,
            2,
            "clickPoint and drag must each resolve their window through the guard"
        )
        // And the refusal must name the off-screen case specifically, because
        // "that did not work" sends the model looking for better coordinates.
        XCTAssertTrue(
            text.contains("target_window_offscreen"),
            "the refusal must distinguish an off-screen target from a missed coordinate"
        )
    }
}
