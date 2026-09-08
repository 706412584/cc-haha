import AppKit
import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

@MainActor
final class SnapshotKeyboardWindowTests: XCTestCase {
    private let pid: pid_t = 66_984
    private let mainID: CGWindowID = 2_389
    private let auxiliaryID: CGWindowID = 2_392
    private let identity = AXTreeProcessIdentity(
        bundleID: "com.netease.163music",
        executablePath: "/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic",
        launchTime: 1
    )

    func testAuxiliaryWindowAtTheFrontDoesNotReplaceThePublishedKeyboardWindow() throws {
        let windows = [auxiliaryWindow(), mainWindow()]
        XCTAssertEqual(WindowGeometry.frontmostWindow(pid: pid, windowList: { windows })?.id, auxiliaryID)

        let selected = try resolve(snapshotID: mainID, windows: windows)
        XCTAssertEqual(selected.id, mainID)
        XCTAssertEqual(selected.bounds, CGRect(x: 333, y: 199, width: 1063, height: 752))
        XCTAssertEqual(selected.ownerPid, pid)
    }

    func testReorderingCGWindowsDoesNotChangeTheSnapshotTarget() throws {
        for windows in [[mainWindow(), auxiliaryWindow()], [auxiliaryWindow(), mainWindow()]] {
            XCTAssertEqual(try resolve(snapshotID: mainID, windows: windows).id, mainID)
        }
    }

    func testASnapshotOfTheSmallWindowIsNotReplacedByTheLargestWindow() throws {
        let selected = try resolve(snapshotID: auxiliaryID, windows: [mainWindow(), auxiliaryWindow()])
        XCTAssertEqual(selected.id, auxiliaryID)
        XCTAssertEqual(selected.bounds, CGRect(x: 343, y: 175, width: 66, height: 20))
    }

    func testClosingTheMainWindowRequiresANewSnapshotInsteadOfFallingBackToAuxiliary() {
        assertError("stale_window") {
            try resolve(snapshotID: mainID, windows: [auxiliaryWindow()])
        }
    }

    func testExactLookupCannotReturnAWindowOwnedByAnotherPID() {
        assertError("stale_window") {
            try SnapshotKeyboardWindow.resolve(
                pid: pid, snapshot: evidence(mainID), currentIdentity: identity,
                windowForID: { id, owner in
                    XCTAssertEqual(id, self.mainID)
                    XCTAssertEqual(owner, self.pid)
                    return .init(id: id, bounds: CGRect(x: 333, y: 199, width: 1063, height: 752), ownerPid: owner + 1)
                }
            )
        }
    }

    func testExactLookupCannotSubstituteADifferentWindowID() {
        assertError("stale_window") {
            try SnapshotKeyboardWindow.resolve(
                pid: pid, snapshot: evidence(mainID), currentIdentity: identity,
                windowForID: { _, owner in
                    .init(id: self.auxiliaryID, bounds: CGRect(x: 343, y: 175, width: 66, height: 20), ownerPid: owner)
                }
            )
        }
    }

    func testMissingOrZeroSnapshotWindowNeverCallsTheWindowLookup() {
        for windowID: CGWindowID? in [nil, 0] {
            assertError("stale_window") {
                try SnapshotKeyboardWindow.resolve(
                    pid: pid, snapshot: evidence(windowID), currentIdentity: identity,
                    windowForID: { _, _ in XCTFail("there is no exact window to look up"); return nil }
                )
            }
        }
    }

    func testNoSnapshotDoesNotInferAWindowFromTheRunningProcess() {
        assertError("stale_snapshot") {
            try SnapshotKeyboardWindow.resolve(
                pid: pid, snapshot: nil, currentIdentity: identity,
                windowForID: { _, _ in XCTFail("no published snapshot means no lookup"); return nil }
            )
        }
    }

    func testReusedPIDCannotInheritThePreviousProcessWindowSnapshot() {
        let replacement = AXTreeProcessIdentity(
            bundleID: identity.bundleID, executablePath: identity.executablePath, launchTime: 2
        )
        assertError("stale_process") {
            try SnapshotKeyboardWindow.resolve(
                pid: pid, snapshot: evidence(mainID), currentIdentity: replacement,
                windowForID: { _, _ in XCTFail("process evidence must be checked before window lookup"); return nil }
            )
        }
    }

    func testANewSnapshotForTheReplacementProcessCanUseItsProvenWindow() throws {
        let replacement = AXTreeProcessIdentity(
            bundleID: identity.bundleID, executablePath: identity.executablePath, launchTime: 2
        )
        let windows = [auxiliaryWindow(), mainWindow()]
        let selected = try SnapshotKeyboardWindow.resolve(
            pid: pid,
            snapshot: .init(processIdentity: replacement, keyWindowID: mainID),
            currentIdentity: replacement,
            windowForID: { id, owner in WindowGeometry.window(id: id, pid: owner, windowList: { windows }) }
        )
        XCTAssertEqual(selected.id, mainID)
    }

    func testSnapshotWindowSurvivesRealActivationAndCoverInTheFocusPreparationJoin() async throws {
        let coordinator = SyntheticWindowFocus.Coordinator()
        let center = NotificationCenter()
        let observer = SyntheticWindowFocus.ApplicationLifecycleObserver(center: center, coordinator: coordinator)
        defer { withExtendedLifetime(observer) {} }
        let application = SnapshotWindowNotificationApplication(pid: pid)
        let observations = KeyboardWindowFocusObservations()
        let identity = identity
        let runtime = SyntheticWindowFocus.Runtime(
            identity: { _ in identity },
            isActive: { _ in observations.active },
            hasFocus: { _ in observations.focused },
            acceptsInput: { _ in observations.accepted },
            post: { _, _, window in
                observations.postedWindowIDs.append(window?.id)
                observations.focused = true
                observations.accepted = true
                return true
            },
            pause: { await Task.yield() }
        )

        for cycle in 0..<2 {
            let windows = cycle == 0 ? [mainWindow(), auxiliaryWindow()] : [auxiliaryWindow(), mainWindow()]
            let target = try resolve(snapshotID: mainID, windows: windows)
            let focusWindow = SyntheticWindowFocus.Window(id: target.id, bounds: target.bounds, activationPoint: nil)
            try await coordinator.prepare(pid: pid, window: focusWindow, runtime: runtime)
            try await coordinator.prepare(pid: pid, window: focusWindow, runtime: runtime)

            if cycle == 0 {
                observations.active = true
                center.post(name: NSWorkspace.didActivateApplicationNotification, object: nil,
                            userInfo: [NSWorkspace.applicationUserInfoKey: application])
                observations.active = false
                observations.focused = false
                observations.accepted = false
                center.post(name: NSWorkspace.didDeactivateApplicationNotification, object: nil,
                            userInfo: [NSWorkspace.applicationUserInfoKey: application])
            }
        }
        XCTAssertEqual(observations.postedWindowIDs, [mainID, mainID])
    }

    private func resolve(snapshotID: CGWindowID?, windows: [[CFString: Any]]) throws -> WindowGeometry.Window {
        try SnapshotKeyboardWindow.resolve(
            pid: pid, snapshot: evidence(snapshotID), currentIdentity: identity,
            windowForID: { id, owner in WindowGeometry.window(id: id, pid: owner, windowList: { windows }) }
        )
    }

    private func evidence(_ id: CGWindowID?) -> AXTreeSnapshotEvidence {
        .init(processIdentity: identity, keyWindowID: id)
    }

    private func mainWindow() -> [CFString: Any] {
        window(id: mainID, x: 333, y: 199, width: 1063, height: 752)
    }

    private func auxiliaryWindow() -> [CFString: Any] {
        window(id: auxiliaryID, x: 343, y: 175, width: 66, height: 20)
    }

    private func window(id: CGWindowID, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) -> [CFString: Any] {
        [
            kCGWindowNumber: Int(id), kCGWindowOwnerPID: pid, kCGWindowLayer: 0,
            kCGWindowBounds: ["X": x, "Y": y, "Width": width, "Height": height] as [String: CGFloat],
        ]
    }

    private func assertError(_ code: String, operation: () throws -> WindowGeometry.Window) {
        XCTAssertThrowsError(try operation()) { error in
            XCTAssertEqual((error as? CUError)?.code, code)
            XCTAssertTrue((error as? CUError)?.message.contains("get_app_state") == true)
        }
    }
}

@MainActor
private final class KeyboardWindowFocusObservations {
    var active = false
    var focused = false
    var accepted = false
    var postedWindowIDs: [CGWindowID?] = []
}

private final class SnapshotWindowNotificationApplication: NSRunningApplication, @unchecked Sendable {
    private let fixturePID: pid_t
    init(pid: pid_t) { fixturePID = pid; super.init() }
    override var processIdentifier: pid_t { fixturePID }
}
