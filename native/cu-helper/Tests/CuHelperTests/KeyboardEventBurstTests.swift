import AppKit
import Carbon.HIToolbox
import CoreGraphics
import os
import XCTest

@testable import cc_haha_computer_use

final class KeyboardEventBurstTests: XCTestCase {
    @MainActor
    func testProductionDispatchAllocatesAFreshHIDSourceForEachPressAndSeparatelyRestoresSessionFlags() async throws {
        var sources: [CGEventSource] = []
        var flagQueries: [CGEventSourceStateID] = []
        var physicalFlags: CGEventFlags = []
        var preparations = 0
        var posted: [[CGEvent]] = []
        let baselines: [CGEventFlags] = [[.maskShift, .maskAlphaShift], [.maskControl, .maskAlternate]]

        for (index, key) in ["cmd+a", "Return"].enumerated() {
            var burst: [CGEvent] = []
            try await KeyboardEventBurst.dispatch(
                chords: KeyMapping.parse(key),
                prepare: {
                    await Task.yield()
                    physicalFlags = baselines[index]
                    preparations += 1
                },
                makeSource: {
                    let source = try KeyboardEventBurst.makeSource()
                    sources.append(source)
                    return source
                },
                readFlagsState: { state in
                    XCTAssertEqual(preparations, index + 1, "read physical modifiers after focus preparation")
                    flagQueries.append(state)
                    // A wrong read domain must not accidentally return the
                    // expected physical baseline and make this test pass.
                    return state == .combinedSessionState ? physicalFlags : .maskNumericPad
                },
                validateBeforePosting: {},
                post: { burst.append($0) }
            )
            posted.append(burst)
        }

        XCTAssertEqual(sources.count, 2)
        XCTAssertFalse(sources[0] === sources[1], "each press must own a fresh source")
        XCTAssertEqual(sources.map(\.sourceStateID), [.hidSystemState, .hidSystemState])
        XCTAssertEqual(flagQueries, [.combinedSessionState, .combinedSessionState])
        XCTAssertEqual(posted.map { $0.map(\.type) }, [
            [.flagsChanged, .keyDown, .flagsChanged, .keyUp],
            [.flagsChanged, .keyDown, .flagsChanged, .keyUp],
        ])
        XCTAssertEqual(posted[0].map(\.flags), [.maskCommand, .maskCommand, baselines[0], .maskCommand])
        XCTAssertEqual(posted[1].map(\.flags), [[], [], baselines[1], []])
        for event in posted.flatMap({ $0 }) {
            XCTAssertEqual(event.getIntegerValueField(.eventSourceStateID), Int64(CGEventSourceStateID.hidSystemState.rawValue))
            XCTAssertEqual(event.getIntegerValueField(.eventSourceUserData), HelperEventMarker.value)
        }
    }

    func testBareReturnExplicitlyClearsModifiersBeforeKeyDown() throws {
        let events = try KeyboardEventBurst.allocate(
            chords: KeyMapping.parse("Return"),
            source: makeSource(),
            restoringFlags: []
        )

        XCTAssertEqual(events.map(\.type), [.flagsChanged, .keyDown, .flagsChanged, .keyUp])
        XCTAssertEqual(events.map(\.flags), [[], [], [], []])
        XCTAssertEqual(keyCodes(in: events), [Int64(kVK_Return), Int64(kVK_Return)])
    }

    func testCommandShortcutThenReturnDoesNotCarryCommandIntoReturn() throws {
        let source = try makeSource()
        let shortcut = try KeyMapping.parse("cmd+a")
        let enter = try KeyMapping.parse("Return")
        let events = try KeyboardEventBurst.allocate(
            chords: shortcut,
            source: source,
            restoringFlags: []
        ) + KeyboardEventBurst.allocate(
            chords: enter,
            source: source,
            restoringFlags: []
        )

        XCTAssertEqual(events.map(\.type), [
            .flagsChanged, .keyDown, .flagsChanged, .keyUp,
            .flagsChanged, .keyDown, .flagsChanged, .keyUp,
        ])
        XCTAssertEqual(events.map(\.flags), [
            .maskCommand, .maskCommand, [], .maskCommand,
            [], [], [], [],
        ])
        XCTAssertEqual(keyCodes(in: events), [
            Int64(shortcut[0].keyCode), Int64(shortcut[0].keyCode),
            Int64(enter[0].keyCode), Int64(enter[0].keyCode),
        ])
    }

    func testMultipleChordsRestoreCapturedUserModifiersWithoutAddingThemToKeys() throws {
        let userFlags: CGEventFlags = [.maskShift, .maskAlternate, .maskAlphaShift]
        let chords = try KeyMapping.parse("cmd+a Return")
        let events = try KeyboardEventBurst.allocate(
            chords: chords,
            source: makeSource(),
            restoringFlags: userFlags
        )

        XCTAssertEqual(events.map(\.type), [
            .flagsChanged, .keyDown, .flagsChanged, .keyUp,
            .flagsChanged, .keyDown, .flagsChanged, .keyUp,
        ])
        XCTAssertEqual(events.map(\.flags), [
            .maskCommand, .maskCommand, userFlags, .maskCommand,
            [], [], userFlags, [],
        ])
        XCTAssertEqual(keyCodes(in: events), [
            Int64(chords[0].keyCode), Int64(chords[0].keyCode),
            Int64(chords[1].keyCode), Int64(chords[1].keyCode),
        ])
    }

    func testEveryEventRetainsTheSuppliedSourceMarker() throws {
        let source = try makeSource()
        let events = try KeyboardEventBurst.allocate(
            chords: KeyMapping.parse("cmd+shift+Tab Return"),
            source: source,
            restoringFlags: .maskControl
        )

        XCTAssertEqual(events.count, 8)
        for event in events {
            XCTAssertEqual(
                event.getIntegerValueField(.eventSourceUserData),
                HelperEventMarker.value
            )
        }
    }

    func testAnyAllocationFailureWithholdsTheEntireMultiChordBurst() throws {
        let source = try makeSource()
        let chords = try KeyMapping.parse("cmd+a Return")

        for failureIndex in 0..<8 {
            var allocationCount = 0
            var consumed: [CGEvent] = []

            XCTAssertThrowsError(try {
                let events = try KeyboardEventBurst.allocate(
                    chords: chords,
                    source: source,
                    restoringFlags: .maskShift,
                    allocateEvent: { spec, source in
                        defer { allocationCount += 1 }
                        guard allocationCount != failureIndex else { return nil }
                        return KeyboardEventBurst.makeEvent(spec, source: source)
                    }
                )
                consumed.append(contentsOf: events)
            }()) { error in
                XCTAssertEqual((error as? CUError)?.code, "event_alloc")
            }

            XCTAssertEqual(allocationCount, failureIndex + 1)
            XCTAssertTrue(consumed.isEmpty)
        }
    }

    func testConsumerReceivesOnlyFullyAllocatedEventsInOrder() throws {
        var allocationCount = 0
        var consumed: [CGEvent] = []
        let events = try KeyboardEventBurst.allocate(
            chords: KeyMapping.parse("cmd+a Return"),
            source: makeSource(),
            restoringFlags: .maskAlternate,
            allocateEvent: { spec, source in
                XCTAssertTrue(consumed.isEmpty)
                allocationCount += 1
                return KeyboardEventBurst.makeEvent(spec, source: source)
            }
        )
        for event in events {
            XCTAssertEqual(allocationCount, 8)
            consumed.append(event)
        }

        XCTAssertEqual(consumed.map(\.type), [
            .flagsChanged, .keyDown, .flagsChanged, .keyUp,
            .flagsChanged, .keyDown, .flagsChanged, .keyUp,
        ])
    }

    @MainActor
    func testDispatchRejectsClipboardCopyDuringFocusPreparationWithoutPosting() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        XCTAssertTrue(pasteboard.setString("original", forType: .string))
        let lease = ClipboardLease(pasteboard: pasteboard)
        try lease.writeTemporaryString("agent temporary text")
        var posted: [CGEvent] = []
        var validated = false

        do {
            try await KeyboardEventBurst.dispatch(
                chords: KeyMapping.parse("cmd+v"), source: makeSource(),
                prepare: {
                    await Task.yield()
                    pasteboard.clearContents()
                    XCTAssertTrue(pasteboard.setString("new user copy", forType: .string))
                },
                restoringFlags: { [] },
                validateBeforePosting: {
                    validated = true
                    guard lease.temporaryWriteIsCurrent() else {
                        throw CUError("clipboard_changed", "The user copied during focus preparation")
                    }
                },
                post: { posted.append($0) }
            )
            XCTFail("changed clipboard must never be pasted into the automation target")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "clipboard_changed")
        }
        XCTAssertTrue(validated)
        XCTAssertTrue(posted.isEmpty)
        XCTAssertFalse(lease.restoreIfUnchanged())
        XCTAssertEqual(pasteboard.string(forType: .string), "new user copy")
    }

    @MainActor
    func testDispatchCancelledDuringPreparationNeverValidatesOrPosts() async throws {
        var posted: [CGEvent] = []
        var validations = 0
        let source = try makeSource()
        let chords = try KeyMapping.parse("cmd+v")
        let task = Task { @MainActor in
            try await KeyboardEventBurst.dispatch(
                chords: chords, source: source,
                prepare: {
                    await Task.yield()
                    withUnsafeCurrentTask { $0?.cancel() }
                },
                restoringFlags: { [] },
                validateBeforePosting: { validations += 1 },
                post: { posted.append($0) }
            )
        }
        do {
            try await task.value
            XCTFail("cancellation after focus preparation must withhold the burst")
        } catch is CancellationError {}
        XCTAssertEqual(validations, 0)
        XCTAssertTrue(posted.isEmpty)
    }

    @MainActor
    func testDispatchDoesNotYieldBetweenFinalClipboardValidationAndTheBurst() async throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let lease = ClipboardLease(pasteboard: pasteboard)
        try lease.writeTemporaryString("agent temporary text")
        var queuedCopy: Task<Void, Never>?
        var posted: [CGEvent] = []

        try await KeyboardEventBurst.dispatch(
            chords: KeyMapping.parse("cmd+v"), source: makeSource(),
            prepare: { await Task.yield() }, restoringFlags: { [] },
            validateBeforePosting: {
                XCTAssertTrue(lease.temporaryWriteIsCurrent())
                queuedCopy = Task { @MainActor in
                    pasteboard.clearContents()
                    XCTAssertTrue(pasteboard.setString("queued user copy", forType: .string))
                }
            },
            post: {
                XCTAssertTrue(lease.temporaryWriteIsCurrent(), "validation and posting must not yield the main actor")
                posted.append($0)
            }
        )
        XCTAssertEqual(posted.count, 4)
        await queuedCopy?.value
        XCTAssertEqual(pasteboard.string(forType: .string), "queued user copy")
        XCTAssertFalse(lease.restoreIfUnchanged())
    }

    @MainActor
    func testDispatchCancelledBeforeEntryDoesNotPrepareOrPost() async throws {
        var preparations = 0
        var posted: [CGEvent] = []
        let source = try makeSource()
        let chords = try KeyMapping.parse("Return")
        let task = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            try await KeyboardEventBurst.dispatch(
                chords: chords, source: source,
                prepare: { preparations += 1 },
                restoringFlags: { [] }, validateBeforePosting: {},
                post: { posted.append($0) }
            )
        }
        do {
            try await task.value
            XCTFail("already-cancelled dispatch must not establish focus")
        } catch is CancellationError {}
        XCTAssertEqual(preparations, 0)
        XCTAssertTrue(posted.isEmpty)
    }

    @MainActor
    func testDispatchReadsModifiersAfterPreparationAndPostsTheRealFourEventBurst() async throws {
        var flags: CGEventFlags = []
        var stages: [String] = []
        var posted: [CGEvent] = []
        let chords = try KeyMapping.parse("cmd+v")
        try await KeyboardEventBurst.dispatch(
            chords: chords, source: makeSource(),
            prepare: {
                MainActor.assertIsolated()
                stages.append("prepare")
                await Task.yield()
                flags = [.maskShift, .maskAlphaShift]
            },
            restoringFlags: {
                MainActor.assertIsolated()
                stages.append("baseline")
                return flags
            },
            validateBeforePosting: {
                MainActor.assertIsolated()
                XCTAssertTrue(posted.isEmpty)
                stages.append("validate")
            },
            post: {
                MainActor.assertIsolated()
                stages.append("post")
                posted.append($0)
            }
        )

        XCTAssertEqual(stages, ["prepare", "baseline", "validate", "post", "post", "post", "post"])
        XCTAssertEqual(posted.map(\.type), [.flagsChanged, .keyDown, .flagsChanged, .keyUp])
        XCTAssertEqual(posted.map(\.flags), [.maskCommand, .maskCommand, flags, .maskCommand])
        XCTAssertEqual(keyCodes(in: posted), [Int64(chords[0].keyCode), Int64(chords[0].keyCode)])
        XCTAssertTrue(posted.allSatisfy { $0.getIntegerValueField(.eventSourceUserData) == HelperEventMarker.value })
    }

    @MainActor
    func testDispatchRejectsThePreparedReceiptAfterMonitorLossOrReplacement() async throws {
        for replaceRegistration in [false, true] {
            let rig = KeyboardFocusTestRig()
            var receipt: FocusEventMonitor.RegistrationReceipt?
            var posted: [CGEvent] = []
            var finalValidationReached = false
            do {
                try await KeyboardEventBurst.dispatch(
                    chords: KeyMapping.parse("Return"), source: makeSource(),
                    prepare: { receipt = try await rig.prepare() },
                    restoringFlags: {
                        XCTAssertEqual(rig.preparations, 1)
                        rig.stream.interrupt()
                        if replaceRegistration { XCTAssertTrue(rig.register()) }
                        return []
                    },
                    validateBeforePosting: {
                        finalValidationReached = true
                        try SyntheticWindowFocus.validate(receipt, monitor: rig.monitor)
                    },
                    post: { posted.append($0) }
                )
                XCTFail("a new or interrupted monitor cannot validate the preparation's original receipt")
            } catch let error as CUError {
                XCTAssertEqual(error.code, "focus_monitor_interrupted")
            }
            XCTAssertTrue(finalValidationReached)
            XCTAssertTrue(posted.isEmpty)
            XCTAssertEqual(rig.preparations, 1)
            if replaceRegistration {
                let replacement = try XCTUnwrap(rig.monitor.registrationReceipt(pid: rig.pid))
                XCTAssertNotEqual(receipt, replacement)
                XCTAssertNoThrow(try SyntheticWindowFocus.validate(replacement, monitor: rig.monitor))
            } else {
                XCTAssertNil(rig.monitor.registrationReceipt(pid: rig.pid))
            }
        }
    }

    @MainActor
    func testDispatchAcceptsTheSameHealthyReceiptAndPostsTheCompleteBurst() async throws {
        let rig = KeyboardFocusTestRig()
        var receipt: FocusEventMonitor.RegistrationReceipt?
        var posted: [CGEvent] = []
        try await KeyboardEventBurst.dispatch(
            chords: KeyMapping.parse("Return"), source: makeSource(),
            prepare: { receipt = try await rig.prepare() },
            restoringFlags: { [] },
            validateBeforePosting: {
                try SyntheticWindowFocus.validate(receipt, monitor: rig.monitor)
            },
            post: { posted.append($0) }
        )
        XCTAssertEqual(rig.preparations, 1)
        XCTAssertEqual(receipt, rig.monitor.registrationReceipt(pid: rig.pid))
        XCTAssertEqual(posted.map(\.type), [.flagsChanged, .keyDown, .flagsChanged, .keyUp])
        XCTAssertEqual(posted.map(\.flags), [[], [], [], []])
        XCTAssertEqual(keyCodes(in: posted), [Int64(kVK_Return), Int64(kVK_Return)])
    }

    private func makeSource() throws -> CGEventSource {
        let source = try XCTUnwrap(CGEventSource(stateID: .privateState))
        source.userData = HelperEventMarker.value
        return source
    }

    private func keyCodes(in events: [CGEvent]) -> [Int64] {
        events.filter { $0.type == .keyDown || $0.type == .keyUp }
            .map { $0.getIntegerValueField(.keyboardEventKeycode) }
    }
}

/// Real registration, coordinator preparation, and receipt validation; only
/// external focus acknowledgement and the underlying event stream are fake.
@MainActor
private final class KeyboardFocusTestRig {
    let pid: pid_t = 42
    let coordinator = SyntheticWindowFocus.Coordinator()
    let stream: KeyboardFocusTestStream
    let monitor: FocusEventMonitor
    private(set) var preparations = 0
    private var acknowledged = false

    init() {
        let stream = KeyboardFocusTestStream()
        self.stream = stream
        monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, isFocusObserver: { _ in false },
            makeStream: { stream }, releaseFocus: { _ in true },
            readRealFrontmost: { 9 }, isOrdinaryApp: { _ in true },
            readProcessIdentity: { .init(executablePath: "/test/\($0)", launchTime: 1) }
        )
    }

    func register() -> Bool {
        let pid = pid
        return monitor.register(pid: pid) { [coordinator] in
            coordinator.observeFocus(pid: pid, hasFocus: $0)
        }
    }

    func prepare() async throws -> FocusEventMonitor.RegistrationReceipt {
        XCTAssertTrue(register())
        let receipt = try XCTUnwrap(monitor.registrationReceipt(pid: pid))
        try await coordinator.prepare(pid: pid, window: nil, runtime: .init(
            identity: { _ in
                AXTreeProcessIdentity(bundleID: "com.example.keyboard-target",
                                      executablePath: "/test/42", launchTime: 1)
            },
            isActive: { _ in false },
            hasFocus: { [monitor] in monitor.isAppCurrentlyFocused(pid: $0) },
            acceptsInput: { [self] _ in acknowledged },
            post: { [self] _, _, _ in acknowledged = true; return true },
            pause: { await Task.yield() },
            validateContinuity: { [monitor] in
                try SyntheticWindowFocus.validate(receipt, monitor: monitor)
            }
        ))
        preparations += 1
        return receipt
    }
}

private final class KeyboardFocusTestStream: FocusEventMonitor.Stream, @unchecked Sendable {
    private let interruption = OSAllocatedUnfairLock<(@Sendable (String) -> Void)?>(initialState: nil)

    func start(
        receive: @escaping @Sendable (FocusEventMonitor.Event) -> FocusEventMonitor.Disposition,
        interrupted: @escaping @Sendable (String) -> Void
    ) -> Bool {
        interruption.withLock { $0 = interrupted }
        return true
    }

    func addProtectedPID(_ pid: pid_t) -> Bool { true }
    func stop() {}
    func interrupt() { interruption.withLock { $0 }?("keyboard_test_interruption") }
}
