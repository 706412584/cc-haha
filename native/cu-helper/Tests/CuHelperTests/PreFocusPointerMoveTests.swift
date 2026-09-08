import AppKit
import XCTest

@testable import cc_haha_computer_use

final class PreFocusPointerMoveTests: XCTestCase {
    private enum ExpectedError: Error { case staleTarget }

    func testProductionClickRoutesItsPointerMoveThroughProtectedPreFocusPreparation() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/cu-helper")
        let source = try String(contentsOf: root.appendingPathComponent("AXAction.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "public static func clickPoint("))
        let end = try XCTUnwrap(source.range(of: "static func clickEvents(", range: start.upperBound..<source.endIndex))
        let click = String(source[start.upperBound..<end.lowerBound])
        XCTAssertTrue(click.contains("beforeFocus:"), "the monitor must be installed before the pointer move")
        XCTAssertTrue(click.contains("try await movePointerBeforeFocus("), "visual cursor motion does not deliver the target's hover event")
        let focus = try String(contentsOf: root.appendingPathComponent("SyntheticWindowFocus.swift"), encoding: .utf8)
        XCTAssertTrue(focus.contains("try await beforeFocus?(receipt)"), "focus preparation must invoke the callback with its original receipt")
    }

    @MainActor
    func testProtectedProductionMovePrecedesFocusThenUnpacedClickAndPreservesReceipt() async throws {
        let fixture = Fixture()
        var originalReceipt: FocusEventMonitor.RegistrationReceipt?
        let receipt = try await fixture.prepare { receipt in
            originalReceipt = receipt
            XCTAssertTrue(fixture.stream.protectedPIDs.contains(fixture.window.ownerPid))
            XCTAssertTrue(fixture.monitor.isRegistrationCurrent(receipt))
            try await AXAction.movePointerBeforeFocus(
                at: fixture.point, window: fixture.window,
                validate: { try SyntheticWindowFocus.validate(receipt, monitor: fixture.monitor) },
                post: { fixture.events.append($0); fixture.trace.append("move") },
                pause: {
                    XCTAssertEqual($0, .milliseconds(10))
                    fixture.trace.append("hover-wait")
                    await Task.yield()
                }
            )
        }
        XCTAssertEqual(receipt, originalReceipt)
        let click = try AXAction.clickEvents(
            at: fixture.point, clickCount: 1, button: .left,
            source: XCTUnwrap(CGEventSource(stateID: .privateState)),
            pid: fixture.window.ownerPid, window: fixture.window
        )
        try await MouseEventBurstDelivery.deliver(
            events: click,
            validate: { try SyntheticWindowFocus.validate(receipt, monitor: fixture.monitor) },
            post: { fixture.events.append($0) },
            release: { _, _ in XCTFail("a complete click does not need cleanup") }
        )
        XCTAssertEqual(fixture.trace, ["move", "hover-wait", "focus", "acceptance-wait"])
        XCTAssertEqual(fixture.events.map(\.type.rawValue), [5, 13, 1, 2, 1, 2])
        let move = try XCTUnwrap(fixture.events.first)
        XCTAssertEqual(move.location, fixture.point)
        XCTAssertEqual(move.flags.rawValue, 0)
        XCTAssertEqual(move.getIntegerValueField(.mouseEventClickState), 1)
        XCTAssertEqual(move.getIntegerValueField(.mouseEventButtonNumber), 0)
        XCTAssertEqual(move.getIntegerValueField(.mouseEventSubtype), 3)
        XCTAssertEqual(move.getIntegerValueField(CGEventField(rawValue: 91)!), Int64(fixture.window.id))
        XCTAssertEqual(move.getIntegerValueField(CGEventField(rawValue: 92)!), Int64(fixture.window.id))
        XCTAssertEqual(try XCTUnwrap(NSEvent(cgEvent: move)).windowNumber, Int(fixture.window.id))
        XCTAssertEqual(click[0].getIntegerValueField(.mouseEventNumber), move.getIntegerValueField(.mouseEventNumber) + 1)
        XCTAssertEqual(click[0].getIntegerValueField(.mouseEventNumber), click[1].getIntegerValueField(.mouseEventNumber))
    }

    @MainActor
    func testFailedMonitorInstallationCannotCallThePointerPreparation() async throws {
        let fixture = Fixture()
        fixture.stream.startsSuccessfully = false
        do {
            _ = try await fixture.prepare { _ in XCTFail("input must not precede protection") }
            XCTFail("missing protection must fail closed")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_monitor_unavailable")
        }
        XCTAssertTrue(fixture.events.isEmpty)
    }

    @MainActor
    func testPointerAllocationFailureCannotPostOrPrepareFocus() async throws {
        let fixture = Fixture()
        do {
            _ = try await fixture.prepare { receipt in
                try await AXAction.movePointerBeforeFocus(
                    at: fixture.point, window: fixture.window,
                    validate: { try SyntheticWindowFocus.validate(receipt, monitor: fixture.monitor) },
                    post: { _ in XCTFail("a failed allocation cannot post") },
                    pause: { _ in XCTFail("a failed allocation cannot wait") },
                    makeEvent: { _, _ in nil }
                )
            }
            XCTFail("failed hover allocation must stop before activation")
        } catch let error as CUError {
            XCTAssertEqual(error.code, CUError.Code.eventAlloc)
        }
        XCTAssertTrue(fixture.events.isEmpty)
    }

    @MainActor
    func testTargetValidationBeforeAllocationBeforePostAndAfterWaitStopsTheAction() async throws {
        for failureAt in 1...3 {
            let fixture = Fixture()
            var validations = 0
            do {
                _ = try await fixture.prepare { _ in
                    try await AXAction.movePointerBeforeFocus(
                        at: fixture.point, window: fixture.window,
                        validate: {
                            validations += 1
                            if validations == failureAt { throw ExpectedError.staleTarget }
                        },
                        post: { fixture.events.append($0) },
                        pause: { _ in await Task.yield() }
                    )
                }
                XCTFail("a stale target cannot progress to focus preparation")
            } catch ExpectedError.staleTarget {}
            XCTAssertEqual(fixture.events.map(\.type), failureAt == 3 ? [.mouseMoved] : [])
            XCTAssertTrue(fixture.trace.isEmpty)
        }
    }

    @MainActor
    func testMonitorRestartDuringPointerWaitCannotSubstituteANewReceipt() async throws {
        let fixture = Fixture()
        var oldReceipt: FocusEventMonitor.RegistrationReceipt?
        do {
            _ = try await fixture.prepare { receipt in
                oldReceipt = receipt
                try await AXAction.movePointerBeforeFocus(
                    at: fixture.point, window: fixture.window,
                    validate: { try SyntheticWindowFocus.validate(receipt, monitor: fixture.monitor) },
                    post: { fixture.events.append($0) },
                    pause: { _ in
                        await Task.yield()
                        fixture.stream.interrupt()
                        XCTAssertTrue(fixture.monitor.register(pid: fixture.window.ownerPid) { _ in })
                        XCTAssertNotEqual(fixture.monitor.registrationReceipt(pid: fixture.window.ownerPid), receipt)
                    }
                )
            }
            XCTFail("a healthy replacement monitor cannot authorize this in-flight click")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_monitor_interrupted")
        }
        XCTAssertFalse(fixture.monitor.isRegistrationCurrent(try XCTUnwrap(oldReceipt)))
        XCTAssertEqual(fixture.events.map(\.type), [.mouseMoved])
        XCTAssertTrue(fixture.trace.isEmpty)
    }

    @MainActor
    func testPreparationItselfRejectsAReceiptLostInsideTheCallback() async throws {
        let fixture = Fixture()
        do {
            _ = try await fixture.prepare { _ in
                fixture.stream.interrupt()
                XCTAssertTrue(fixture.monitor.register(pid: fixture.window.ownerPid) { _ in })
            }
            XCTFail("the outer preparation must not trust a callback's success")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "focus_monitor_interrupted")
        }
        XCTAssertTrue(fixture.events.isEmpty)
    }

    @MainActor
    func testCancellationBeforeMoveAndDuringItsWaitNeverPostsActivation() async throws {
        for cancelBeforeMove in [true, false] {
            let fixture = Fixture()
            let task = Task { @MainActor in
                do {
                    _ = try await fixture.prepare { _ in
                        if cancelBeforeMove { withUnsafeCurrentTask { $0?.cancel() } }
                        try await AXAction.movePointerBeforeFocus(
                            at: fixture.point, window: fixture.window,
                            validate: {},
                            post: { fixture.events.append($0) },
                            pause: { _ in
                                withUnsafeCurrentTask { $0?.cancel() }
                                await Task.yield()
                            }
                        )
                    }
                    XCTFail("cancellation must stop the click")
                } catch is CancellationError {} catch {
                    XCTFail("unexpected error: \(error)")
                }
            }
            await task.value
            XCTAssertEqual(fixture.events.map(\.type), cancelBeforeMove ? [] : [.mouseMoved])
            XCTAssertTrue(fixture.trace.isEmpty)
        }
    }

    @MainActor
    func testCancellationInsideTheLastValidationCannotPostThePointerMove() async throws {
        let fixture = Fixture()
        var validations = 0
        let task = Task { @MainActor in
            do {
                try await AXAction.movePointerBeforeFocus(
                    at: fixture.point, window: fixture.window,
                    validate: {
                        validations += 1
                        if validations == 2 { withUnsafeCurrentTask { $0?.cancel() } }
                    },
                    post: { _ in XCTFail("validation canceled this input") },
                    pause: { _ in XCTFail("an unposted move must not wait") }
                )
                XCTFail("cancellation must be observed after validation")
            } catch is CancellationError {} catch {
                XCTFail("unexpected error: \(error)")
            }
        }
        await task.value
        XCTAssertEqual(validations, 2)
    }

    @MainActor
    func testPreparationWithoutCallbackKeepsTheExistingFocusPath() async throws {
        let fixture = Fixture()
        let receipt = try await fixture.prepare()
        XCTAssertTrue(fixture.monitor.isRegistrationCurrent(receipt))
        XCTAssertEqual(fixture.trace, ["focus", "acceptance-wait"])
        XCTAssertEqual(fixture.events.map(\.type.rawValue), [13, 1, 2])
    }
}

private final class PointerFocusStream: FocusEventMonitor.Stream, @unchecked Sendable {
    var startsSuccessfully = true
    private(set) var protectedPIDs: [pid_t] = []
    private var interrupted: (@Sendable (String) -> Void)?

    func start(
        receive: @escaping @Sendable (FocusEventMonitor.Event) -> FocusEventMonitor.Disposition,
        interrupted: @escaping @Sendable (String) -> Void
    ) -> Bool {
        self.interrupted = interrupted
        return startsSuccessfully
    }
    func addProtectedPID(_ pid: pid_t) -> Bool { protectedPIDs.append(pid); return true }
    func stop() {}
    func interrupt() { interrupted?("test_interruption") }
}

@MainActor
private final class Fixture {
    let window = WindowGeometry.Window(id: 123, bounds: CGRect(x: 200, y: 300, width: 800, height: 600), ownerPid: 42)
    let point = CGPoint(x: 410, y: 349)
    let coordinator = SyntheticWindowFocus.Coordinator()
    let stream = PointerFocusStream()
    let monitor: FocusEventMonitor
    var events: [CGEvent] = []
    var trace: [String] = []

    init() {
        let stream = stream
        monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, isFocusObserver: { $0 == 901 },
            makeStream: { stream }, releaseFocus: { _ in true },
            readRealFrontmost: { 9 }, isOrdinaryApp: { _ in true },
            readProcessIdentity: { .init(executablePath: "/test/\($0)", launchTime: 1) }
        )
    }

    func prepare(
        beforeFocus: (@MainActor (FocusEventMonitor.RegistrationReceipt) async throws -> Void)? = nil
    ) async throws -> FocusEventMonitor.RegistrationReceipt {
        let context = SyntheticWindowFocus.Window(id: window.id, bounds: window.bounds, activationPoint: CGPoint(x: -1, y: 1118))
        return try await SyntheticWindowFocus.prepareInput(
            pid: window.ownerPid, window: context, monitor: monitor, coordinator: coordinator,
            runtime: .init(
                identity: { _ in .init(bundleID: "com.example.pointer", executablePath: "/test/42", launchTime: 1) },
                isActive: { _ in false }, hasFocus: { _ in false }, acceptsInput: { _ in true },
                post: { [self] establishment, _, window in
                    XCTAssertEqual(establishment, .activate)
                    guard let activation = SyntheticWindowFocus.activationEvents(window: window) else { return false }
                    trace.append("focus")
                    events.append(contentsOf: activation)
                    return true
                },
                pause: { [self] in await MainActor.run { trace.append("acceptance-wait") } }
            ),
            beforeFocus: beforeFocus
        )
    }
}
