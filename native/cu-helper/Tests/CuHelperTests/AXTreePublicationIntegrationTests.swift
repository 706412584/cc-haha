import AppKit
import XCTest
@testable import cc_haha_computer_use

@MainActor
final class AXTreePublicationIntegrationTests: XCTestCase {
    private enum FixtureError: Error {
        case timedOut
    }

    private static let fixtureFlag = "CC_HAHA_AX_PUBLICATION_FIXTURE"
    private static let fixtureReadyPath = "CC_HAHA_AX_PUBLICATION_READY"
    private static let fixtureStopPath = "CC_HAHA_AX_PUBLICATION_STOP"
    private static let fixtureTitle = "CC_HAHA_AX_PUBLICATION_TITLE"
    private static let fixtureMismatchedTitle = "CC_HAHA_AX_PUBLICATION_MISMATCHED_TITLE"
    private static let fixtureGesturePath = "CC_HAHA_AX_PUBLICATION_GESTURES"
    private static let fixtureRegularActivation = "CC_HAHA_AX_PUBLICATION_REGULAR_ACTIVATION"
    private static let fixtureWideWindow = "CC_HAHA_AX_PUBLICATION_WIDE_WINDOW"
    private static let fixtureMethods = "CC_HAHA_AX_PUBLICATION_METHOD_CONTRACT"

    func testPublishedControlBelowDuplicateAncestorClicksImmediatelyAndRejectsOldGeneration() async throws {
        try await verifyPublishedControl(mismatchedWindowTitle: false)
    }

    func testChromeStyleAXTitleCanDifferFromWindowServerTitleWithoutDisablingActions() async throws {
        try await verifyPublishedControl(mismatchedWindowTitle: true)
    }

    func testConsecutiveZeroAndOnePixelDragsReachTheAppWithoutIntermediateObservations() async throws {
        try await verifyPublishedControl(mismatchedWindowTitle: false, exerciseDrags: true)
    }

    func testOfficialKeyboardAliasesAndMacroReachTheNativeReceiver() async throws {
        try await verifyPublishedControl(mismatchedWindowTitle: false, exerciseKeys: true)
    }

    func testWideWindowUsesOfficialScreenshotSizeAndKeepsDragCoordinatesAligned() async throws {
        try await verifyPublishedControl(mismatchedWindowTitle: false, exerciseDrags: true, wideWindow: true)
    }

    func testTextScrollAndSecondaryMethodsReachTheSameOfficialReceiver() async throws {
        if ProcessInfo.processInfo.environment[Self.fixtureFlag] == "1" {
            try await runFixtureProcess(mismatchedWindowTitle: false, regularActivation: true, wideWindow: false)
            exit(0)
        }
        try XCTSkipUnless(AXIsProcessTrusted(), "Native contract receiver requires Accessibility permission")
        try XCTSkipUnless(Capture.hasScreenRecordingPermission(), "Coordinate scroll requires Screen Recording permission")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cc-haha-method-contract-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let ready = root.appendingPathComponent("ready")
        let stop = root.appendingPathComponent("stop")
        let receiptPath = root.appendingPathComponent("contract.json")
        let pasteboardName = "cc-haha-method-contract-\(UUID().uuidString)"
        let pasteboard = NSPasteboard(name: NSPasteboard.Name(pasteboardName))
        pasteboard.clearContents()
        pasteboard.setString("disposable original clipboard", forType: .string)
        defer { pasteboard.releaseGlobally() }
        let app = try makeFixtureApp(in: root)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = Array(CommandLine.arguments.dropFirst())
        configuration.environment = ProcessInfo.processInfo.environment.merging([
            Self.fixtureFlag: "1", Self.fixtureMethods: "1",
            Self.fixtureReadyPath: ready.path, Self.fixtureStopPath: stop.path,
            Self.fixtureTitle: "Native method contract fixture",
            "CC_HAHA_METHOD_FIXTURE_PASTEBOARD": pasteboardName,
        ]) { _, value in value }
        configuration.activates = false
        configuration.createsNewApplicationInstance = true
        let process = try await NSWorkspace.shared.openApplication(at: app, configuration: configuration)
        defer {
            FileManager.default.createFile(atPath: stop.path, contents: Data())
            if !process.isTerminated { process.terminate() }
        }
        try await waitUntil(description: "method fixture ready") { FileManager.default.fileExists(atPath: ready.path) && FileManager.default.fileExists(atPath: receiptPath.path) }
        let pid = process.processIdentifier
        defer { AXTree.invalidate(pid: pid) }
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        _ = monitor.startAndWait()
        defer { monitor.stop() }
        let cursor = VirtualCursor(headless: false)
        defer { cursor.hide() }
        let router = CommandRouter(cursor: cursor, capabilities: Capabilities(headless: false), inputMonitor: monitor,
                                   pasteExecutor: { pid, text, format in
            try await AXAction.pasteText(pid: pid, text, format: format, lease: ClipboardLease(pasteboard: pasteboard))
        })
        func state() async throws -> AXTree.Result { try await AXTree.appState(pid: pid, disableDiff: true) }
        func receipt() -> [String: Any] {
            guard let data = try? Data(contentsOf: receiptPath),
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
            return value
        }
        var coordinateCaptureDiagnostic = "not captured"
        func diagnostic() -> String {
            let windows = (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? [])
                .filter { $0[kCGWindowOwnerPID as String] as? Int == Int(pid) }
                .map { ["id": $0[kCGWindowNumber as String] ?? "nil", "bounds": $0[kCGWindowBounds as String] ?? "nil", "onScreen": $0[kCGWindowIsOnscreen as String] ?? "nil", "layer": $0[kCGWindowLayer as String] ?? "nil"] }
            return "snapshot=\(String(describing: AXTree.snapshotEvidence(pid: pid))) capture=\(coordinateCaptureDiagnostic) windows=\(windows) receipt=\(receipt())"
        }
        var observed = try await state()
        var editor = try publishedHandle(label: "Contract editor", state: observed).0
        func action(_ command: String, _ args: [String: JSONValue]) async throws {
            do {
                _ = try await router.handle(cmd: command, payload: .object(args.merging(["pid": .int(Int(pid))]) { current, _ in current }))
            } catch {
                print("[native-six-method-failure] command=\(command) \(diagnostic())")
                throw error
            }
        }
        try await action("set_value", ["index": .string(editor.rawValue), "value": .string("alpha beta gamma")])
        observed = try await state()
        editor = try publishedHandle(label: "Contract editor", state: observed).0
        try await action("select_text", ["index": .string(editor.rawValue), "text": .string("beta")])
        try await waitUntil(description: "beta selected") { receipt()["selectionLocation"] as? Int == 6 && receipt()["selectionLength"] as? Int == 4 }
        try await action("type_text", ["text": .string("typed")])
        try await waitUntil(description: "selection replaced by typeText", diagnostic: { "\(receipt())" }) { receipt()["text"] as? String == "alpha typed gamma" }
        observed = try await state()
        editor = try publishedHandle(label: "Contract editor", state: observed).0
        try await action("select_text", ["index": .string(editor.rawValue), "text": .string("typed")])
        try await action("paste", ["text": .string("pasted"), "format": .string("text")])
        try await waitUntil(description: "selection replaced by paste") { receipt()["text"] as? String == "alpha pasted gamma" }
        XCTAssertEqual(pasteboard.string(forType: .string), "disposable original clipboard")
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.status, "completed")
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.dataSupplied, true)
        XCTAssertEqual(ClipboardPasteReceipt.lastDiagnostic?.restored, true)
        XCTAssertEqual(receipt()["selectionLocation"] as? Int, 12)
        XCTAssertEqual(receipt()["selectionLength"] as? Int, 0)
        observed = try await state()
        let scroll = try publishedHandle(label: "Contract scroll", state: observed).0
        var wheelCount = 0
        func scrollAndReceive(_ args: [String: JSONValue], x: Double? = nil, y: Double? = nil) async throws {
            try await action("scroll", args)
            wheelCount += 1
            try await waitUntil(description: "scroll event \(wheelCount)", diagnostic: diagnostic) {
                let current = receipt()
                guard (current["wheel"] as? [[String: Any]])?.count == wheelCount else { return false }
                if let x, abs((current["scrollX"] as? Double ?? -.infinity) - x) > 0.01 { return false }
                if let y, abs((current["scrollY"] as? Double ?? -.infinity) - y) > 0.01 { return false }
                return true
            }
        }
        try await scrollAndReceive(["index": .string(scroll.rawValue), "direction": .string("down"), "pages": .double(0.5)], y: 105)
        XCTAssertEqual(try XCTUnwrap(receipt()["scrollY"] as? Double), 105, accuracy: 0.01)
        try await scrollAndReceive(["index": .string(scroll.rawValue), "direction": .string("down"), "pages": .double(1.5)], y: 420)
        XCTAssertEqual(try XCTUnwrap(receipt()["scrollY"] as? Double), 420, accuracy: 0.01)
        let coordinateState = try await router.handle(cmd: "get_app_state", payload: .object(["pid": .int(Int(pid)), "disableDiff": .bool(true)]))
        if case .object(let stateObject) = coordinateState,
           case .object(let screenshot) = stateObject["screenshot"] {
            coordinateCaptureDiagnostic = "\(screenshot.filter { $0.key != "base64" })"
        }
        try await scrollAndReceive(["x": .int(380), "y": .int(377), "direction": .string("down"), "pages": .double(0.5)], y: 696)
        XCTAssertEqual(try XCTUnwrap(receipt()["scrollY"] as? Double), 696, accuracy: 0.01)
        try await scrollAndReceive(["x": .int(380), "y": .int(377), "direction": .string("up"), "pages": .double(0.5)], y: 420)
        XCTAssertEqual(try XCTUnwrap(receipt()["scrollY"] as? Double), 420, accuracy: 0.01)
        try await scrollAndReceive(["index": .string(scroll.rawValue), "direction": .string("up"), "pages": .double(0.5)], y: 315)
        try await scrollAndReceive(["index": .string(scroll.rawValue), "direction": .string("down"), "pages": .double(0.123)], y: 341)
        XCTAssertEqual(try XCTUnwrap(receipt()["scrollY"] as? Double), 341, accuracy: 0.01)
        // Intentional improvement over the inspected official wheelCount=1:
        // keep the second wheel axis so horizontal scrolling remains usable.
        try await scrollAndReceive(["index": .string(scroll.rawValue), "direction": .string("right"), "pages": .double(0.5)], x: 360)
        XCTAssertEqual(try XCTUnwrap(receipt()["scrollX"] as? Double), 360, accuracy: 0.01)
        try await scrollAndReceive(["index": .string(scroll.rawValue), "direction": .string("left"), "pages": .double(0.5)], x: 0)
        XCTAssertEqual(try XCTUnwrap(receipt()["scrollX"] as? Double), 0, accuracy: 0.01)
        try await action("perform_secondary_action", ["index": .string(scroll.rawValue), "action": .string("Scroll Down")])
        try await waitUntil(description: "secondary AX page scroll", diagnostic: diagnostic) {
            receipt()["scrollY"] as? Double == 524
        }
        let wheel = try XCTUnwrap(receipt()["wheel"] as? [[String: Any]])
        XCTAssertEqual(wheel.compactMap { $0["y"] as? Double }, [-105, -315, -276, 276, 105, -26, 0, 0])
        XCTAssertEqual(wheel.compactMap { $0["x"] as? Double }, [0, 0, 0, 0, 0, 0, -360, 360])
        XCTAssertTrue(wheel.allSatisfy { $0["precise"] as? Bool == true })
        print("[native-six-method-smoke] \(receipt())")
        FileManager.default.createFile(atPath: stop.path, contents: Data())
        try await waitUntil(description: "method fixture exit") { process.isTerminated }
    }

    private func verifyPublishedControl(mismatchedWindowTitle: Bool, exerciseDrags: Bool = false, exerciseKeys: Bool = false, wideWindow: Bool = false) async throws {
        if ProcessInfo.processInfo.environment[Self.fixtureFlag] == "1" {
            try await runFixtureProcess(
                mismatchedWindowTitle: ProcessInfo.processInfo.environment[Self.fixtureMismatchedTitle] == "1",
                regularActivation: ProcessInfo.processInfo.environment[Self.fixtureRegularActivation] == "1",
                wideWindow: ProcessInfo.processInfo.environment[Self.fixtureWideWindow] == "1"
            )
            // This process is a disposable UI fixture, not another suite run.
            exit(0)
        }
        try XCTSkipUnless(
            AXIsProcessTrusted(),
            "Live AX publication requires Accessibility permission for the test runner"
        )
        if mismatchedWindowTitle || exerciseDrags {
            try XCTSkipUnless(
                Capture.hasScreenRecordingPermission(),
                "Coordinate publication requires Screen Recording permission for the test runner"
            )
        }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("cc-haha-ax-publication-\(UUID().uuidString)")
        let ready = root.appendingPathComponent("ready")
        let stop = root.appendingPathComponent("stop")
        let gestures = root.appendingPathComponent("gestures.json")
        let title = "Computer Use snapshot publication \(UUID().uuidString)"
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        // AXTree requires a proven process lifetime, and querying the test runner's
        // own AX tree cannot exercise a cross-process action. Relaunch this same
        // test as a temporary app bundle so the production AX/WindowServer path
        // supplies every snapshot field instead of a hand-written fixture.
        let fixtureApp = try makeFixtureApp(in: root)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = Array(CommandLine.arguments.dropFirst())
        configuration.environment = ProcessInfo.processInfo.environment.merging([
            Self.fixtureFlag: "1",
            Self.fixtureReadyPath: ready.path,
            Self.fixtureStopPath: stop.path,
            Self.fixtureTitle: title,
            Self.fixtureMismatchedTitle: mismatchedWindowTitle ? "1" : "0",
            Self.fixtureGesturePath: gestures.path,
            // A full-suite child enters the first test, so fixture modes must
            // travel with this launch rather than that test method's defaults.
            Self.fixtureRegularActivation: exerciseKeys ? "1" : "0",
            Self.fixtureWideWindow: wideWindow ? "1" : "0",
        ]) { _, fixture in fixture }
        configuration.activates = false
        configuration.createsNewApplicationInstance = true
        let process = try await NSWorkspace.shared.openApplication(
            at: fixtureApp,
            configuration: configuration
        )
        defer {
            FileManager.default.createFile(atPath: stop.path, contents: Data())
            if !process.isTerminated { process.terminate() }
        }

        try await waitUntil(description: "fixture launch") { FileManager.default.fileExists(atPath: ready.path) }
        let pid = process.processIdentifier
        defer { AXTree.invalidate(pid: pid) }
        let identities = FixtureIdentityDiagnostics(pid: pid)
        defer { identities.finish() }

        let state = try await AXTree.appState(pid: pid, disableDiff: true)
        let windowID = try XCTUnwrap(AXTree.snapshotEvidence(pid: pid)?.keyWindowID)
        XCTAssertEqual(AXTree.currentKeyWindowID(pid: pid), windowID)
        let (handle, line) = try publishedHandle(label: "Bold", state: state)
        XCTAssertEqual(
            AXTree.record(pid: pid, index: handle.index)?.role,
            kAXCheckBoxRole as String
        )
        XCTAssertTrue(line.contains("Value: 0"), line)
        let inputMonitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        _ = inputMonitor.startAndWait()
        defer { inputMonitor.stop() }
        let cursor = VirtualCursor(headless: false)
        defer { cursor.hide() }
        let router = CommandRouter(
            cursor: cursor,
            capabilities: Capabilities(headless: false),
            inputMonitor: inputMonitor
        )
        identities.stage = "initial indexed click"
        let click = try await router.handle(
            cmd: "click",
            payload: .object([
                "pid": .int(Int(pid)),
                "index": .string(handle.rawValue),
            ])
        )
        XCTAssertEqual(click, .bool(true))

        let clickedState = try await AXTree.appState(pid: pid, disableDiff: true)
        let (_, clickedLine) = try publishedHandle(label: "Bold", state: clickedState)
        XCTAssertTrue(clickedLine.contains("Value: 1"), clickedLine)

        if exerciseKeys {
            let (canvasHandle, _) = try publishedHandle(label: "Drag fixture", state: clickedState)
            var phase = "canvas click"
            do {
                _ = try await router.handle(cmd: "click", payload: .object([
                    "pid": .int(Int(pid)), "index": .string(canvasHandle.rawValue),
                ]))
                phase = "keyboard macro"
                _ = try await router.handle(cmd: "press_key", payload: .object([
                    "pid": .int(Int(pid)),
                    "key": .string("Control_L+a Super_R+b A question Delete BackSpace"),
                ]))
            } catch {
                let windows = (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? [])
                    .filter { $0[kCGWindowOwnerPID as String] as? Int == Int(pid) }
                    .map { ["id": $0[kCGWindowNumber as String] ?? "nil", "bounds": $0[kCGWindowBounds as String] ?? "nil", "onScreen": $0[kCGWindowIsOnscreen as String] ?? "nil", "layer": $0[kCGWindowLayer as String] ?? "nil"] }
                let frame = AXTree.record(pid: pid, index: canvasHandle.index)?.frameGlobal
                let receipt = (try? String(contentsOf: gestures, encoding: .utf8)) ?? "no receipt"
                throw CUError((error as? CUError)?.code ?? "fixture_action_failed",
                              "\(error.localizedDescription) Fixture phase=\(phase), pid=\(pid), terminated=\(process.isTerminated), canvas=\(String(describing: frame)), windows=\(windows), receipt=\(receipt)")
            }
            try await waitUntil(description: "six received macro keys") {
                guard let data = try? Data(contentsOf: gestures),
                      let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let keys = receipt["keys"] as? [[String: Any]] else { return false }
                return keys.count == 6
            }
            let receipt = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: gestures)) as? [String: Any])
            let keys = try XCTUnwrap(receipt["keys"] as? [[String: Any]])
            XCTAssertEqual(keys.compactMap { $0["keyCode"] as? Int }, [0, 11, 0, 44, 117, 51])
            XCTAssertEqual(keys.compactMap { $0["modifiers"] as? UInt }, [262144, 1048576, 131072, 131072, 0, 0])
            let discovered = try await Apps.listApps()
            XCTAssertEqual(discovered.first { $0.id == process.bundleIdentifier }?.isRunning, true)
            print("[native-key-smoke] six-key macro received, inventory entries=\(discovered.count), recent=\(discovered.filter { !$0.isRunning }.count)")
        }

        if exerciseDrags {
            let captured = try await router.handle(cmd: "get_app_state", payload: .object([
                "pid": .int(Int(pid)), "disableDiff": .bool(true),
            ]))
            let shot = try XCTUnwrap(captured["screenshot"])
            if wideWindow {
                XCTAssertEqual(shot["width"]?.asInt, 1397)
                XCTAssertEqual(shot["height"]?.asInt, 768)
                XCTAssertEqual(shot["pointWidth"]?.asDouble, 1398)
                XCTAssertEqual(shot["pointHeight"]?.asDouble, 769)
                XCTAssertEqual(shot["mimeType"]?.asString, "image/jpeg")
                XCTAssertEqual(try XCTUnwrap(shot["pixelsPerPoint"]?.asDouble), 768.0 / 769.0, accuracy: 0.000001)
                let bytes = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(shot["base64"]?.asString)))
                XCTAssertEqual(Array(bytes.prefix(2)), [255, 216])
            }
            let canvasState = try await AXTree.appState(pid: pid, disableDiff: true)
            let (canvasHandle, _) = try publishedHandle(label: "Drag fixture", state: canvasState)
            let frame = try XCTUnwrap(AXTree.record(pid: pid, index: canvasHandle.index)?.frameGlobal)
            let x = wideWindow ? 300 : (frame.x + frame.w / 2 - (try XCTUnwrap(shot["originX"]?.asDouble)))
                * Double(try XCTUnwrap(shot["width"]?.asInt))
                / (try XCTUnwrap(shot["pointWidth"]?.asDouble))
            let y = wideWindow ? 180 : (frame.y + frame.h / 2 - (try XCTUnwrap(shot["originY"]?.asDouble)))
                * Double(try XCTUnwrap(shot["height"]?.asInt))
                / (try XCTUnwrap(shot["pointHeight"]?.asDouble))
            let started = ContinuousClock.now
            for index in 0..<12 {
                // Same observed canvas and viewport throughout. Alternating zero
                // and one pixel exercises the Townscaper-style gesture without
                // relying on a browser, a real document, or model decisions.
                identities.stage = "drag \(index)"
                do {
                    _ = try await router.handle(cmd: "drag", payload: .object([
                        "pid": .int(Int(pid)),
                        "from": .object(["x": .double(x), "y": .double(y)]),
                        "to": .object(["x": .double(x + Double(index % 2)), "y": .double(y)]),
                    ]))
                } catch {
                    print("[native-drag-smoke] failed step \(index), fixture terminated=\(process.isTerminated), stop=\(FileManager.default.fileExists(atPath: stop.path)), snapshot=\(String(describing: AXTree.snapshotEvidence(pid: pid)?.processIdentity)), live=\(String(describing: AXTree.currentProcessIdentity(pid: pid))), receiver=\((try? String(contentsOf: gestures, encoding: .utf8)) ?? "no receipt")")
                    throw error
                }
            }
            identities.stage = "final observation"
            let final = try await router.handle(cmd: "get_app_state", payload: .object([
                "pid": .int(Int(pid)), "disableDiff": .bool(true),
            ]))
            XCTAssertNotNil(final["screenshot"])
            try await waitUntil(description: "12 received gestures", diagnostic: {
                "terminated=\(process.isTerminated) stop=\(FileManager.default.fileExists(atPath: stop.path)) receiver=\((try? String(contentsOf: gestures, encoding: .utf8)) ?? "no gesture receipt")"
            }) {
                guard let data = try? Data(contentsOf: gestures),
                      let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { return false }
                return receipt["completed"] as? Int == 12
            }
            let receipt = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: Data(contentsOf: gestures)) as? [String: Any]
            )
            XCTAssertEqual(receipt["completed"] as? Int, 12)
            XCTAssertEqual(receipt["drags"] as? Int, 12, "zero-distance gestures must still contain a dragged event")
            XCTAssertEqual(receipt["unpaired"] as? Int, 0)
            if wideWindow {
                let events = try XCTUnwrap(receipt["events"] as? [[String: Any]])
                let down = try XCTUnwrap(events.first { $0["type"] as? UInt == NSEvent.EventType.leftMouseDown.rawValue })
                // Measured from the official App.drag on the same window size:
                // x300/y180 uses a uniform 769/768 inverse fit on both axes.
                XCTAssertEqual(try XCTUnwrap(down["x"] as? Double), 300.390625, accuracy: 0.000001)
                XCTAssertEqual(try XCTUnwrap(down["y"] as? Double), 588.765625, accuracy: 0.000001)
            }
            #if DEBUG
            XCTAssertGreaterThan(identities.samples, 0, "the identity experiment must observe real production validation")
            #endif
            print("[native-drag-smoke] 12 received gestures + final observation: \(started.duration(to: .now))")
        }

        if mismatchedWindowTitle {
            // Exercise the actual state → screenshot → coordinate action path,
            // using only this disposable fixture window. Previously the image
            // was returned while its coordinate transform was never recorded.
            let captured = try await router.handle(cmd: "get_app_state", payload: .object([
                "pid": .int(Int(pid)), "disableDiff": .bool(true),
            ]))
            let shot = try XCTUnwrap(captured["screenshot"])
            XCTAssertEqual(shot["windowID"]?.asInt, Int(windowID))
            let frame = try XCTUnwrap(AXTree.record(pid: pid, index: handle.index)?.frameGlobal)
            let x = (frame.x + frame.w / 2 - (try XCTUnwrap(shot["originX"]?.asDouble)))
                * Double(try XCTUnwrap(shot["width"]?.asInt))
                / (try XCTUnwrap(shot["pointWidth"]?.asDouble))
            let y = (frame.y + frame.h / 2 - (try XCTUnwrap(shot["originY"]?.asDouble)))
                * Double(try XCTUnwrap(shot["height"]?.asInt))
                / (try XCTUnwrap(shot["pointHeight"]?.asDouble))
            _ = try await router.handle(cmd: "click", payload: .object([
                "pid": .int(Int(pid)), "x": .double(x), "y": .double(y),
            ]))
            let coordinateState = try await AXTree.appState(pid: pid, disableDiff: true)
            let (coordinateHandle, coordinateLine) = try publishedHandle(label: "Bold", state: coordinateState)
            XCTAssertTrue(coordinateLine.contains("Value: 0"), coordinateLine)
            // Restore the checked state for the stale-generation assertion.
            _ = try await router.handle(cmd: "click", payload: .object([
                "pid": .int(Int(pid)), "index": .string(coordinateHandle.rawValue),
            ]))
        }

        AXTree.invalidate(pid: pid)
        let nextState = try await AXTree.appState(pid: pid, disableDiff: true)
        let (nextHandle, _) = try publishedHandle(label: "Bold", state: nextState)
        XCTAssertNotEqual(nextHandle.snapshotID, handle.snapshotID)
        do {
            _ = try await router.handle(
                cmd: "click",
                payload: .object([
                    "pid": .int(Int(pid)),
                    "index": .string(handle.rawValue),
                ])
            )
            XCTFail("the old generation must not reach the action")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "stale_snapshot")
        }
        let unchangedState = try await AXTree.appState(pid: pid, disableDiff: true)
        let (_, unchangedLine) = try publishedHandle(label: "Bold", state: unchangedState)
        XCTAssertTrue(unchangedLine.contains("Value: 1"), unchangedLine)

        FileManager.default.createFile(atPath: stop.path, contents: Data())
        try await waitUntil(description: "fixture exit") { process.isTerminated }
    }

    private func runFixtureProcess(mismatchedWindowTitle: Bool, regularActivation: Bool, wideWindow: Bool) async throws {
        let environment = ProcessInfo.processInfo.environment
        let readyPath = try XCTUnwrap(environment[Self.fixtureReadyPath])
        if environment[Self.fixtureMethods] == "1" {
            try NativeMethodContractFixture.run(root: URL(fileURLWithPath: readyPath).deletingLastPathComponent())
            return
        }
        let stopPath = try XCTUnwrap(environment[Self.fixtureStopPath])
        let title = try XCTUnwrap(environment[Self.fixtureTitle])

        let app = NSApplication.shared
        app.setActivationPolicy(regularActivation ? .regular : .accessory)
        app.finishLaunching()
        let window = NSWindow(
            contentRect: NSRect(x: 200, y: 200, width: wideWindow ? 1398 : 420, height: wideWindow ? 737 : 180),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        if regularActivation {
            // This is a utility receiver, not a document in the user's active
            // app set. A regular app's window can otherwise be reduced to a
            // WindowServer preview while AX still reports its full-size frame.
            // Keep it eligible to join the current set without changing any
            // system preference, window level, or production input safeguard.
            window.collectionBehavior = [.canJoinAllApplications]
        }
        window.title = title
        if mismatchedWindowTitle {
            // Chrome exposes a decorated AX title while WindowServer uses the
            // page title (and may add an audio indicator). Both refer to the
            // same window. Reproduce that mismatch without a real browser.
            window.setAccessibilityTitle("\(title) - Google Chrome - Fixture")
        }
        // TextEdit exposes formatting and alignment segments as two sibling
        // AXGroups whose own fingerprints are identical. Their description-only
        // children are the first semantic evidence that distinguishes the paths.
        let formattingControls = ["Bold", "Italic", "Underline"].map { label -> NSButton in
            let button = NSButton(checkboxWithTitle: "", target: nil, action: nil)
            button.setAccessibilityLabel(label)
            return button
        }
        let alignmentControls = ["Align Left", "Align Center", "Align Right"].map {
            label -> NSButton in
            let button = NSButton(checkboxWithTitle: "", target: nil, action: nil)
            button.setAccessibilityLabel(label)
            return button
        }
        let formattingGroup = NSStackView(views: formattingControls)
        formattingGroup.frame = NSRect(x: 20, y: 60, width: 180, height: 60)
        formattingGroup.orientation = .horizontal
        formattingGroup.spacing = 12
        formattingGroup.setAccessibilityElement(true)
        formattingGroup.setAccessibilityRole(.group)
        let alignmentGroup = NSStackView(views: alignmentControls)
        alignmentGroup.frame = NSRect(x: 220, y: 60, width: 180, height: 60)
        alignmentGroup.orientation = .horizontal
        alignmentGroup.spacing = 12
        alignmentGroup.setAccessibilityElement(true)
        alignmentGroup.setAccessibilityRole(.group)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 180))
        content.addSubview(formattingGroup)
        content.addSubview(alignmentGroup)
        let canvas = DragReceiptView(frame: wideWindow
            ? NSRect(x: 20, y: 130, width: 1358, height: 580)
            : NSRect(x: 20, y: 15, width: 380, height: 30))
        canvas.receiptPath = try XCTUnwrap(environment[Self.fixtureGesturePath])
        canvas.setAccessibilityElement(true)
        canvas.setAccessibilityRole(.group)
        canvas.setAccessibilityLabel("Drag fixture")
        content.addSubview(canvas)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        app.activate()
        defer {
            window.orderOut(nil)
            window.close()
        }
        try await Task.sleep(for: .milliseconds(100))

        FileManager.default.createFile(atPath: readyPath, contents: Data())
        // XCTest's async wait services AX requests, but does not run AppKit's
        // native event dispatcher. A receiving-app fixture needs NSApp.run to
        // consume synthetic activation and mouse events just like a real app.
        let stopTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
            if FileManager.default.fileExists(atPath: stopPath) { exit(0) }
        }
        defer { stopTimer.invalidate() }
        app.run()
    }

    private func waitUntil(
        description: String,
        timeout: Duration = .seconds(5),
        diagnostic: () -> String = { "" },
        _ predicate: () -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("Timed out waiting for \(description): \(diagnostic())")
        throw FixtureError.timedOut
    }

    private func makeFixtureApp(in root: URL) throws -> URL {
        let app = root.appendingPathComponent("AXPublicationFixture.app", isDirectory: true)
        let contents = app.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)

        let executable = macOS.appendingPathComponent("AXPublicationFixture")
        try FileManager.default.copyItem(
            at: URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath(),
            to: executable
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: executable.path
        )
        let info: [String: Any] = [
            "CFBundleExecutable": "AXPublicationFixture",
            "CFBundleIdentifier": "dev.cchaha.tests.ax-publication-fixture",
            "CFBundleName": "AXPublicationFixture",
            "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1",
        ]
        let plist = try PropertyListSerialization.data(
            fromPropertyList: info,
            format: .xml,
            options: 0
        )
        try plist.write(to: contents.appendingPathComponent("Info.plist"), options: .atomic)
        return app
    }

    private func publishedHandle(
        label: String,
        state: AXTree.Result
    ) throws -> (SnapshotElementHandle, String) {
        let line = try XCTUnwrap(
            state.axText.split(separator: "\n").first {
                $0.contains("Description: \(label)") || $0.hasSuffix("container \(label)")
            }.map(String.init),
            state.axText
        )
        let rawHandle = try XCTUnwrap(
            line.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init)
        )
        return (try XCTUnwrap(SnapshotElementHandle(rawValue: rawHandle)), line)
    }
}

/// Records what the receiving process actually consumed, independently of the
/// sender's event builder. AppKit may coalesce motion, so assert complete drag
/// gestures rather than requiring every intermediate event at this boundary.
@MainActor
private final class DragReceiptView: NSView {
    var receiptPath = ""
    private var held = false
    private var dragged = false
    private var completed = 0
    private var drags = 0
    private var unpaired = 0
    private var events: [[String: Any]] = []
    private var keys: [[String: Any]] = []

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        if held { unpaired += 1 }
        held = true
        dragged = false
        record(event)
    }

    override func keyDown(with event: NSEvent) {
        keys.append([
            "keyCode": Int(event.keyCode),
            "modifiers": event.modifierFlags.intersection([.command, .control, .shift, .option]).rawValue,
        ])
        writeReceipt()
    }

    override func mouseDragged(with event: NSEvent) {
        if !held { unpaired += 1 }
        dragged = true
        record(event)
    }

    override func mouseUp(with event: NSEvent) {
        if !held { unpaired += 1 }
        completed += 1
        if dragged { drags += 1 }
        held = false
        record(event)
    }

    private func record(_ event: NSEvent) {
        events.append([
            "type": event.type.rawValue,
            "number": event.eventNumber,
            "clicks": event.clickCount,
            "x": event.locationInWindow.x,
            "y": event.locationInWindow.y,
            "timestamp": event.timestamp,
        ])
        writeReceipt()
    }

    private func writeReceipt() {
        let receipt: [String: Any] = [
            "completed": completed, "drags": drags, "unpaired": unpaired,
            "held": held, "events": events, "keys": keys,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: receipt) {
            try? data.write(to: URL(fileURLWithPath: receiptPath), options: .atomic)
        }
    }
}

@MainActor
private final class FixtureIdentityDiagnostics {
    let pid: pid_t
    var stage = "state"
    private(set) var samples = 0
    private var observed = Set<String>()
    #if DEBUG
    private let previous: ((ProvenProcessTarget, AXTreeProcessIdentity?) -> Void)?
    #endif

    init(pid: pid_t) {
        self.pid = pid
        #if DEBUG
        previous = Injection.targetValidationObserver
        Injection.targetValidationObserver = { [weak self] expected, current in
            guard let self, expected.pid == self.pid else { return }
            self.samples += 1
            self.observed.insert(Self.describe(current))
            if expected.validatedPid(currentIdentity: current) == nil {
                print("[identity-validation] failed pid=\(pid) stage=\(self.stage) sample=\(self.samples) expected=\(Self.describe(expected.identity)) actual=\(Self.describe(current))")
            }
        }
        #endif
    }

    func finish() {
        #if DEBUG
        Injection.targetValidationObserver = previous
        print("[identity-validation] pid=\(pid) samples=\(samples) identities=\(observed.sorted())")
        #endif
    }

    private static func describe(_ identity: AXTreeProcessIdentity?) -> String {
        guard let identity else { return "nil" }
        return "bundle=\(identity.bundleID ?? "nil") path=\(identity.executablePath ?? "nil") launch=\(identity.launchTime.map(String.init(describing:)) ?? "nil") bits=\(identity.launchTime.map { String($0.bitPattern, radix: 16) } ?? "nil")"
    }
}
