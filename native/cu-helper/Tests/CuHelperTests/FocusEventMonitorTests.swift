import Foundation
import os
import XCTest

@testable import cc_haha_computer_use

final class FocusEventMonitorTests: XCTestCase {
    private final class FakeStream: FocusEventMonitor.Stream, @unchecked Sendable {
        var starts = 0
        var stops = 0
        var startsSuccessfully = true
        var keyboardStartsSuccessfully = true
        var interruptDuringStart: String?
        var addHook: (@Sendable (pid_t) -> Bool)?
        private var stopped = false
        var receive: (@Sendable (FocusEventMonitor.Event) -> FocusEventMonitor.Disposition)?
        var interrupted: (@Sendable (String) -> Void)?

        func start(
            receive: @escaping @Sendable (FocusEventMonitor.Event) -> FocusEventMonitor.Disposition,
            interrupted: @escaping @Sendable (String) -> Void
        ) -> Bool {
            starts += 1
            stopped = false
            self.receive = receive
            self.interrupted = interrupted
            if let interruptDuringStart { interrupted(interruptDuringStart) }
            return startsSuccessfully
        }
        func addProtectedPID(_ pid: pid_t) -> Bool { addHook?(pid) ?? keyboardStartsSuccessfully }
        func stop() {
            guard !stopped else { return }
            stopped = true
            stops += 1
        }
    }

    private func event(
        focus: pid_t = 42, subtype: Int64 = 0xf102,
        source: pid_t = 0, target: pid_t = 901, type: UInt32 = 21
    ) -> FocusEventMonitor.Event {
        .init(type: type, subtype: subtype, sourcePID: source,
              targetPID: target, focusPID: focus, focusToken: 17)
    }

    private func monitor(
        _ stream: FakeStream,
        releaseFocus: @escaping @Sendable (UInt32) -> Bool = { _ in true },
        readRealFrontmost: @escaping @Sendable () -> pid_t? = { 9 },
        readProcessIdentity: @escaping @Sendable (pid_t) -> FocusEventMonitor.ProcessIdentity? = {
            .init(executablePath: "/test/\($0)", launchTime: 1)
        }
    ) -> FocusEventMonitor {
        FocusEventMonitor(
            helperPID: 700,
            readInitialFocus: { 9 },
            isFocusObserver: { $0 == 901 },
            makeStream: { stream },
            releaseFocus: releaseFocus,
            readRealFrontmost: readRealFrontmost,
            isOrdinaryApp: { _ in true },
            readProcessIdentity: readProcessIdentity
        )
    }

    func testOnlyRegistrationStartsObservationAndInitialFocusIsNotSynthetic() {
        let stream = FakeStream()
        let monitor = monitor(stream)
        XCTAssertEqual(stream.starts, 0)
        XCTAssertFalse(monitor.isAppCurrentlyFocused(pid: 9))
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        XCTAssertTrue(monitor.isAppCurrentlyFocused(pid: 9))
        XCTAssertFalse(monitor.isAppCurrentlyFocused(pid: 42))
        XCTAssertTrue(monitor.register(pid: 77) { _ in })
        XCTAssertEqual(stream.starts, 1)
    }

    func testUnreadableViewBridgeNameRequiresTheExactSystemExecutable() {
        let systemPath = "/System/Library/PrivateFrameworks/ViewBridge.framework/Versions/A/XPCServices/ViewBridgeAuxiliary.xpc/Contents/MacOS/ViewBridgeAuxiliary"
        XCTAssertTrue(FocusEventMonitor.isViewBridgeProcess(name: "ViewBridgeAuxiliary", executablePath: nil))
        XCTAssertTrue(FocusEventMonitor.isViewBridgeProcess(name: nil, executablePath: systemPath))
        XCTAssertFalse(FocusEventMonitor.isViewBridgeProcess(name: nil, executablePath: nil))
        XCTAssertFalse(FocusEventMonitor.isViewBridgeProcess(
            name: nil, executablePath: "/Applications/Fake.app/Contents/MacOS/ViewBridgeAuxiliary"
        ))
        XCTAssertFalse(FocusEventMonitor.isViewBridgeProcess(name: nil, executablePath: systemPath + "Fake"))
        XCTAssertFalse(FocusEventMonitor.isViewBridgeProcess(name: "DifferentProcess", executablePath: systemPath))
        XCTAssertFalse(FocusEventMonitor.isViewBridgeProcess(name: "ViewBridgeAuxili", executablePath: systemPath))
    }

    func testSystemTransitionNotifiesLossAndGainInBothDirections() {
        let stream = FakeStream()
        let monitor = monitor(stream)
        let changes = OSAllocatedUnfairLock(initialState: [String]())
        XCTAssertTrue(monitor.register(pid: 9) { value in changes.withLock { $0.append("9:\(value)") } })
        XCTAssertTrue(monitor.register(pid: 42) { value in changes.withLock { $0.append("42:\(value)") } })
        _ = stream.receive?(event())
        _ = stream.receive?(event())
        _ = stream.receive?(event(focus: 9))
        XCTAssertEqual(changes.withLock { $0 }, ["9:false", "42:true", "42:false", "9:true"])
        XCTAssertTrue(monitor.isAppCurrentlyFocused(pid: 9))
    }

    func testOnlyViewBridgeFocusChangesRewriteSystemFocusRegardlessOfSource() {
        let stream = FakeStream()
        let monitor = monitor(stream)
        let changes = OSAllocatedUnfairLock(initialState: [Bool]())
        XCTAssertTrue(monitor.register(pid: 42) { value in changes.withLock { $0.append(value) } })
        for notification in [
            event(source: 700), event(target: 42), event(type: 13),
            event(subtype: 0x8000, target: 42), event(subtype: 0x4000),
            event(subtype: 2), event(subtype: 0xf107), event(focus: 0),
        ] {
            let recognized = notification.type == 21 && notification.subtype == 0xf102
                && notification.targetPID == 901 && notification.focusPID > 0
            _ = stream.receive?(notification)
            XCTAssertEqual(monitor.isAppCurrentlyFocused(pid: 42), recognized)
            if recognized { _ = stream.receive?(event(focus: 9)) }
        }
        XCTAssertEqual(changes.withLock { $0 }, [true, false])
        XCTAssertTrue(monitor.isAppCurrentlyFocused(pid: 9))
        XCTAssertFalse(monitor.isAppCurrentlyFocused(pid: 42))
    }

    func testTimeoutInvalidatesBeliefAndRegistrationStartsFreshObservation() {
        let stream = FakeStream()
        let monitor = monitor(stream)
        let changes = OSAllocatedUnfairLock(initialState: [Bool]())
        let callback: FocusEventMonitor.FocusChanged = { value in changes.withLock { $0.append(value) } }
        XCTAssertTrue(monitor.register(pid: 42, onFocusChanged: callback))
        _ = stream.receive?(event())
        let oldReceive = stream.receive
        stream.interrupted?("event_tap_timeout")
        XCTAssertFalse(monitor.diagnostic.available)
        XCTAssertFalse(monitor.isAppCurrentlyFocused(pid: 42))
        XCTAssertEqual(monitor.diagnostic.reason, "event_tap_timeout")
        XCTAssertTrue(monitor.register(pid: 42, onFocusChanged: callback))
        XCTAssertEqual(stream.starts, 2)
        XCTAssertEqual(stream.stops, 1)
        _ = oldReceive?(event())
        XCTAssertTrue(monitor.isAppCurrentlyFocused(pid: 9))
        XCTAssertEqual(changes.withLock { $0 }, [true, false])
        _ = stream.receive?(event())
        XCTAssertEqual(changes.withLock { $0 }, [true, false, true])
    }

    func testCreationFailureReturnsFalseAndCanRetry() {
        let stream = FakeStream()
        stream.startsSuccessfully = false
        let monitor = monitor(stream)
        XCTAssertFalse(monitor.register(pid: 42) { _ in })
        XCTAssertFalse(monitor.diagnostic.available)
        XCTAssertFalse(monitor.isAppCurrentlyFocused(pid: 9))
        stream.startsSuccessfully = true
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        XCTAssertTrue(monitor.diagnostic.available)
    }

    func testUnregisterPreventsLateCallbacksAndCanRestart() {
        let stream = FakeStream()
        let monitor = monitor(stream)
        let changes = OSAllocatedUnfairLock(initialState: [Bool]())
        XCTAssertTrue(monitor.register(pid: 42) { value in changes.withLock { $0.append(value) } })
        let oldReceive = stream.receive
        let oldInterruption = stream.interrupted
        monitor.unregisterAll()
        _ = oldReceive?(event())
        oldInterruption?("late_failure")
        XCTAssertEqual(changes.withLock { $0 }, [])
        XCTAssertEqual(monitor.diagnostic.reason, "stopped")
        XCTAssertFalse(monitor.isAppCurrentlyFocused(pid: 9))
        XCTAssertFalse(monitor.register(pid: -1) { _ in })
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        XCTAssertEqual(stream.starts, 2)
    }

    private func consume(
        _ policy: inout FocusEventMonitor.ProtectionPolicy,
        _ event: FocusEventMonitor.Event, front: pid_t? = 9, observer: Bool = true
    ) -> FocusEventMonitor.ProtectionPolicy.Effect {
        policy.consume(event, helperPID: 700, protectedPIDs: [42],
                       realFrontmostPID: front, isSystemObserver: observer)
    }

    func testCompleteStealReleaseAndKeyboardReturnTransaction() {
        var policy = FocusEventMonitor.ProtectionPolicy(focusedPID: 9)
        XCTAssertEqual(consume(&policy, event(subtype: 0x4000, target: 9)).disposition, .suppress)
        let key = event(target: 42, type: 10)
        XCTAssertEqual(consume(&policy, key).disposition, .redirect(9))
        let focused = consume(&policy, event())
        XCTAssertEqual(focused.releaseToken, 17)
        XCTAssertEqual(focused.focusChanges.map { $0.0 }, [9])
        XCTAssertEqual(focused.focusChanges.map { $0.1 }, [false])
        XCTAssertNil(consume(&policy, event()).releaseToken, "a focus transaction is cancelled once")
        XCTAssertEqual(consume(&policy, event(subtype: 0x8000, target: 9)).disposition, .suppress)
        XCTAssertEqual(consume(&policy, event(subtype: 0x8000, target: 9)).disposition, .pass)
        let restored = consume(&policy, event(focus: 9))
        XCTAssertEqual(restored.focusChanges.map { $0.0 }, [9])
        XCTAssertEqual(restored.focusChanges.map { $0.1 }, [true])
        XCTAssertEqual(policy.focusedPID, 9)
        _ = consume(&policy, event(subtype: 2))
        XCTAssertNil(policy.pending)
        XCTAssertEqual(consume(&policy, key).disposition, .pass)
    }

    func testOnlyMatchedProtectedThiefAndRealVictimCanBeSuppressed() {
        for unmatched in [
            event(subtype: 0x4000, source: 700, target: 9),
            event(focus: 77, subtype: 0x4000, target: 9),
            event(subtype: 0x4000, target: 88),
            event(subtype: 0x4444, target: 9),
        ] {
            var policy = FocusEventMonitor.ProtectionPolicy(focusedPID: 9)
            let matched = unmatched.subtype == 0x4000 && unmatched.focusPID == 42
                && unmatched.targetPID == 9
            XCTAssertEqual(consume(&policy, unmatched).disposition, matched ? .suppress : .pass)
            XCTAssertEqual(policy.pending != nil, matched)
        }
        var policy = FocusEventMonitor.ProtectionPolicy(focusedPID: 9)
        XCTAssertEqual(consume(&policy, event(subtype: 0x4000, target: 9), front: 42).disposition, .pass)
        XCTAssertNil(policy.pending)
    }

    func testPendingProtectionNeverRedirectsOwnOrUnrelatedInput() {
        var policy = FocusEventMonitor.ProtectionPolicy(focusedPID: 9)
        _ = consume(&policy, event(subtype: 0x4000, target: 9))
        for keyType: UInt32 in [10, 11, 12] {
            XCTAssertEqual(consume(&policy, event(source: 700, target: 42, type: keyType)).disposition, .pass)
            XCTAssertEqual(consume(&policy, event(target: 77, type: keyType)).disposition, .pass)
            XCTAssertEqual(consume(&policy, event(target: 42, type: keyType)).disposition, .redirect(9))
        }
        XCTAssertEqual(consume(&policy, event(target: 42, type: 1)).disposition, .pass)
        XCTAssertEqual(consume(&policy, event(subtype: 0x8000, target: 77)).disposition, .pass)
        XCTAssertNil(consume(&policy, event(), observer: false).releaseToken)
        XCTAssertEqual(policy.focusedPID, 9)
    }

    func testRealUserActivationOrUnknownFocusClearsPendingProtection() {
        for nextFront: pid_t? in [42, 77, nil] {
            var policy = FocusEventMonitor.ProtectionPolicy(focusedPID: 9)
            _ = consume(&policy, event(subtype: 0x4000, target: 9))
            XCTAssertEqual(consume(&policy, event(target: 42, type: 10), front: nextFront).disposition, .pass)
            XCTAssertNil(policy.pending)
        }
        var policy = FocusEventMonitor.ProtectionPolicy(focusedPID: 9)
        _ = consume(&policy, event(subtype: 0x4000, target: 9))
        _ = consume(&policy, event(focus: 77))
        XCTAssertNil(policy.pending)
    }

    func testReleaseFailureStopsAutomationButRetainsOnlyTheProvenKeyboardRoute() throws {
        let stream = FakeStream()
        let releases = OSAllocatedUnfairLock(initialState: [UInt32]())
        let monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, isFocusObserver: { $0 == 901 },
            makeStream: { stream }, releaseFocus: { token in
                releases.withLock { $0.append(token) }; return false
            }, readRealFrontmost: { 9 }, isOrdinaryApp: { _ in true },
            readProcessIdentity: { .init(executablePath: "/test/\($0)", launchTime: 1) }
        )
        let changes = OSAllocatedUnfairLock(initialState: [Bool]())
        XCTAssertTrue(monitor.register(pid: 42) { value in changes.withLock { $0.append(value) } })
        let receipt = try XCTUnwrap(monitor.registrationReceipt(pid: 42))
        let continuity = monitor.diagnostic.continuityGeneration
        XCTAssertEqual(stream.receive?(event(subtype: 0x4000, target: 9)), .suppress)
        XCTAssertEqual(stream.receive?(event()), .pass)
        XCTAssertEqual(releases.withLock { $0 }, [17])
        XCTAssertEqual(changes.withLock { $0 }, [false])
        XCTAssertFalse(monitor.diagnostic.available)
        XCTAssertEqual(monitor.diagnostic.reason, "release_key_focus_failed_waiting_for_keyboard_recovery")
        XCTAssertGreaterThan(monitor.diagnostic.continuityGeneration, continuity)
        XCTAssertFalse(monitor.isRegistrationCurrent(receipt))
        XCTAssertNil(monitor.registrationReceipt(pid: 42))
        XCTAssertFalse(monitor.register(pid: 42) { _ in })
        XCTAssertFalse(monitor.register(pid: 77) { _ in })
        XCTAssertEqual(stream.starts, 1)
        XCTAssertEqual(stream.stops, 0, "failure must not remove the user's only keyboard route")
        for type: UInt32 in [10, 11, 12] {
            XCTAssertEqual(stream.receive?(event(target: 42, type: type)), .redirect(9))
            XCTAssertEqual(stream.receive?(event(source: 700, target: 42, type: type)), .pass)
            XCTAssertEqual(stream.receive?(event(target: 77, type: type)), .pass)
        }
        XCTAssertEqual(stream.receive?(event(subtype: 0x4000, target: 9)), .pass)
        XCTAssertEqual(stream.receive?(event(subtype: 0x8000, target: 9)), .pass)
        XCTAssertEqual(stream.receive?(event()), .pass)
        XCTAssertEqual(releases.withLock { $0 }, [17], "draining must not retry cancellation or suppress notifications")
    }

    func testFailedRecoveryEndsOnlyAfterTrustedKeyboardFocusRestoration() {
        let stream = FakeStream()
        let monitor = monitor(stream, releaseFocus: { _ in false })
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        _ = stream.receive?(event(subtype: 0x4000, target: 9))
        _ = stream.receive?(event())
        XCTAssertEqual(stream.receive?(event(focus: 9, target: 42)), .pass)
        XCTAssertEqual(stream.receive?(event(focus: 9, subtype: 0xf107)), .pass)
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .redirect(9))
        XCTAssertEqual(stream.receive?(event(focus: 9, source: 700)), .pass)
        XCTAssertEqual(stream.stops, 1)
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .pass)
        XCTAssertFalse(monitor.diagnostic.available)
        XCTAssertEqual(monitor.diagnostic.reason, "keyboard_focus_recovery_observed")
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        XCTAssertEqual(stream.starts, 2)
    }

    func testActualUserSwitchEndsFailedRecoveryEvenIfFrontLaterReturns() {
        let stream = FakeStream()
        let front = OSAllocatedUnfairLock(initialState: pid_t(9))
        let monitor = monitor(stream, releaseFocus: { _ in false }, readRealFrontmost: { front.withLock { $0 } })
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        _ = stream.receive?(event(subtype: 0x4000, target: 9))
        _ = stream.receive?(event())
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .redirect(9))
        front.withLock { $0 = 77 }
        monitor.observeRealFrontmost(pid: 77)
        front.withLock { $0 = 9 }
        monitor.observeRealFrontmost(pid: 9)
        XCTAssertEqual(stream.stops, 1)
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .pass)
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
    }

    func testUnregisterDuringCancellationCannotDismantleFailedKeyboardRecovery() {
        let stream = FakeStream()
        let holder = OSAllocatedUnfairLock(initialState: Optional<FocusEventMonitor>.none)
        let monitor = monitor(stream, releaseFocus: { _ in
            holder.withLock { $0 }?.unregisterAll()
            return false
        })
        holder.withLock { $0 = monitor }
        defer { holder.withLock { $0 = nil } }
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        _ = stream.receive?(event(subtype: 0x4000, target: 9))
        _ = stream.receive?(event())
        XCTAssertEqual(stream.stops, 0)
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .redirect(9))
        monitor.unregisterAll()
        XCTAssertEqual(stream.stops, 0)
        XCTAssertEqual(stream.receive?(event(target: 42, type: 11)), .redirect(9))
        XCTAssertFalse(monitor.register(pid: 42) { _ in })
        _ = stream.receive?(event(focus: 9))
        XCTAssertEqual(stream.stops, 1)
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
    }

    func testOSDisabledTapCannotPromiseRecoveryAndMustKeepNewAutomationBlocked() {
        let stream = FakeStream()
        let monitor = monitor(stream, releaseFocus: { _ in false })
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        _ = stream.receive?(event(subtype: 0x4000, target: 9))
        _ = stream.receive?(event())
        stream.interrupted?("event_tap_timeout")
        XCTAssertEqual(stream.stops, 1)
        XCTAssertFalse(monitor.diagnostic.available)
        XCTAssertEqual(monitor.diagnostic.reason, "event_tap_timeout_keyboard_safety_forwarding_unavailable")
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .pass)
        XCTAssertFalse(monitor.register(pid: 42) { _ in })
        monitor.observeRealFrontmost(pid: 77)
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
    }

    func testRecoveryNeverRedirectsToAReusedVictimPID() {
        let stream = FakeStream()
        let victimLaunch = OSAllocatedUnfairLock(initialState: TimeInterval(1))
        let monitor = monitor(stream, releaseFocus: { _ in false }, readProcessIdentity: { pid in
            .init(executablePath: "/test/\(pid)", launchTime: pid == 9 ? victimLaunch.withLock { $0 } : 1)
        })
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        _ = stream.receive?(event(subtype: 0x4000, target: 9))
        _ = stream.receive?(event())
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .redirect(9))
        victimLaunch.withLock { $0 = 2 }
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .pass)
        XCTAssertEqual(stream.stops, 1)
        XCTAssertEqual(monitor.diagnostic.reason, "keyboard_recovery_process_identity_changed")
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
    }

    func testUnknownFrontmostDoesNotCountAsAConfirmedRecovery() {
        let stream = FakeStream()
        let front = OSAllocatedUnfairLock(initialState: Optional<pid_t>(9))
        let monitor = monitor(stream, releaseFocus: { _ in false }, readRealFrontmost: { front.withLock { $0 } })
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        _ = stream.receive?(event(subtype: 0x4000, target: 9))
        _ = stream.receive?(event())
        front.withLock { $0 = nil }
        monitor.observeRealFrontmost(pid: nil)
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .pass)
        XCTAssertFalse(monitor.register(pid: 42) { _ in })
        XCTAssertEqual(stream.stops, 0)
        front.withLock { $0 = 9 }
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .redirect(9))
    }

    func testMissingCancellationAndKeyboardTapFailuresCannotEnableHalfProtection() {
        let stream = FakeStream()
        let unsupported = FocusEventMonitor(
            makeStream: { stream }, releaseFocus: nil, isOrdinaryApp: { _ in true }
        )
        XCTAssertFalse(unsupported.register(pid: 42) { _ in })
        XCTAssertEqual(stream.starts, 0)
        stream.keyboardStartsSuccessfully = false
        let monitor = monitor(stream)
        XCTAssertFalse(monitor.register(pid: 42) { _ in })
        XCTAssertEqual(stream.receive?(event(subtype: 0x4000, target: 9)), .pass)
        stream.keyboardStartsSuccessfully = true
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        stream.keyboardStartsSuccessfully = false
        XCTAssertFalse(monitor.register(pid: 77) { _ in })
        XCTAssertFalse(monitor.diagnostic.available)
    }

    func testStartupInterruptionCannotBeOverwrittenBySuccessfulStartReturn() {
        let stream = FakeStream()
        stream.interruptDuringStart = "event_tap_timeout"
        let monitor = monitor(stream)
        XCTAssertFalse(monitor.register(pid: 42) { _ in })
        XCTAssertFalse(monitor.diagnostic.available)
        XCTAssertEqual(monitor.diagnostic.reason, "event_tap_timeout")
    }

    func testHelperSourcedViewBridgeFocusChangeStillReleasesAndRestoresSystemFocus() {
        let stream = FakeStream()
        let releases = OSAllocatedUnfairLock(initialState: [UInt32]())
        let monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, isFocusObserver: { $0 == 901 },
            makeStream: { stream }, releaseFocus: { token in
                releases.withLock { $0.append(token) }; return true
            }, readRealFrontmost: { 9 }, isOrdinaryApp: { _ in true },
            readProcessIdentity: { .init(executablePath: "/test/\($0)", launchTime: 1) }
        )
        let changes = OSAllocatedUnfairLock(initialState: [String]())
        XCTAssertTrue(monitor.register(pid: 9) { value in changes.withLock { $0.append("9:\(value)") } })
        XCTAssertTrue(monitor.register(pid: 42) { value in changes.withLock { $0.append("42:\(value)") } })
        XCTAssertEqual(stream.receive?(event(subtype: 0x4000, target: 9)), .suppress)
        XCTAssertEqual(stream.receive?(event(subtype: 0x8000, source: 700, target: 42)), .pass)
        XCTAssertTrue(monitor.isAppCurrentlyFocused(pid: 9), "our direct returned notification is not system focus")
        XCTAssertEqual(stream.receive?(event(source: 700)), .pass)
        XCTAssertEqual(releases.withLock { $0 }, [17])
        XCTAssertTrue(monitor.isAppCurrentlyFocused(pid: 42))
        XCTAssertEqual(stream.receive?(event(focus: 9, source: 700)), .pass)
        XCTAssertTrue(monitor.isAppCurrentlyFocused(pid: 9))
        XCTAssertEqual(changes.withLock { $0 }, ["9:false", "9:true"])
    }

    func testHelperKeyboardPassesThroughEveryProtectionPhase() {
        let stream = FakeStream()
        let monitor = monitor(stream)
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        let transitions = [
            event(type: 0), event(subtype: 0x4000, target: 9), event(),
            event(focus: 9), event(subtype: 2),
        ]
        for transition in transitions {
            _ = stream.receive?(transition)
            for keyType: UInt32 in [10, 11, 12] {
                XCTAssertEqual(stream.receive?(event(source: 700, target: 42, type: keyType)), .pass)
                XCTAssertEqual(stream.receive?(event(source: 700, target: 9, type: keyType)), .pass)
            }
        }
    }

    func testOldRegistrationFailureCannotInterruptAReplacementGeneration() {
        let oldStream = FakeStream()
        let newStream = FakeStream()
        let streamIndex = OSAllocatedUnfairLock(initialState: 0)
        let monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, isFocusObserver: { $0 == 901 },
            makeStream: {
                streamIndex.withLock { index in
                    defer { index += 1 }
                    return index == 0 ? oldStream : newStream
                }
            }, releaseFocus: { _ in true }, readRealFrontmost: { 9 },
            isOrdinaryApp: { _ in true },
            readProcessIdentity: { .init(executablePath: "/test/\($0)", launchTime: 1) }
        )
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        let oldReceipt = monitor.registrationReceipt(pid: 42)
        oldStream.addHook = { [weak monitor] _ in
            guard let monitor else { return false }
            monitor.unregisterAll()
            XCTAssertTrue(monitor.register(pid: 42) { _ in })
            return false
        }
        XCTAssertFalse(monitor.register(pid: 77) { _ in })
        XCTAssertTrue(monitor.diagnostic.available)
        XCTAssertEqual(newStream.stops, 0)
        XCTAssertFalse(oldReceipt.map { monitor.isRegistrationCurrent($0) } ?? true)
        XCTAssertNotNil(monitor.registrationReceipt(pid: 42))
    }

    func testPIDReplacementInvalidatesReceiptAndRebuildsItsKeyboardTap() throws {
        let stream = FakeStream()
        let launch = OSAllocatedUnfairLock(initialState: TimeInterval(1))
        let monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, isFocusObserver: { $0 == 901 },
            makeStream: { stream }, releaseFocus: { _ in true }, readRealFrontmost: { 9 },
            isOrdinaryApp: { _ in true }, readProcessIdentity: { pid in
                .init(executablePath: "/test/\(pid)", launchTime: launch.withLock { $0 })
            }
        )
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        let original = try XCTUnwrap(monitor.registrationReceipt(pid: 42))
        let oldReceive = stream.receive
        XCTAssertTrue(monitor.isRegistrationCurrent(original))
        XCTAssertEqual(stream.receive?(event(subtype: 0x4000, target: 9)), .suppress)
        launch.withLock { $0 = 2 }
        XCTAssertFalse(monitor.isRegistrationCurrent(original))
        XCTAssertEqual(stream.receive?(event(target: 42, type: 10)), .pass)
        XCTAssertFalse(monitor.diagnostic.available)
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        XCTAssertEqual(stream.starts, 2)
        let replacement = try XCTUnwrap(monitor.registrationReceipt(pid: 42))
        XCTAssertNotEqual(original, replacement)
        XCTAssertTrue(monitor.isRegistrationCurrent(replacement))
        XCTAssertEqual(oldReceive?(event(subtype: 0x4000, target: 9)), .pass)
        XCTAssertTrue(monitor.diagnostic.available)
        monitor.unregisterAll()
        XCTAssertFalse(monitor.isRegistrationCurrent(replacement))
    }

    func testProcessReplacementDuringPIDTapInstallationCannotRegisterOldIdentity() {
        let stream = FakeStream()
        let launch = OSAllocatedUnfairLock(initialState: TimeInterval(1))
        let monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, makeStream: { stream },
            releaseFocus: { _ in true }, isOrdinaryApp: { _ in true },
            readProcessIdentity: { pid in
                .init(executablePath: "/test/\(pid)", launchTime: launch.withLock { $0 })
            }
        )
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        stream.addHook = { _ in launch.withLock { $0 = 2 }; return true }
        XCTAssertFalse(monitor.register(pid: 77) { _ in })
        XCTAssertFalse(monitor.diagnostic.available)
        XCTAssertNil(monitor.registrationReceipt(pid: 77))
    }

    func testWorkerReentryExecutesInlineInsteadOfWaitingForItsOwnRunLoop() {
        let executed = OSAllocatedUnfairLock(initialState: false)
        XCTAssertTrue(FocusNotificationStream.perform(on: CFRunLoopGetCurrent()) {
            executed.withLock { $0 = true }
        })
        XCTAssertTrue(executed.withLock { $0 })
    }

    func testStopBeforeRunAndDuringEntryGapCannotLeaveAnUnboundedWorker() {
        var cancelled = true
        var iterations = 0
        FocusNotificationStream.runWhileActive(isCancelled: { cancelled }) { _ in
            iterations += 1
            return .finished
        }
        XCTAssertEqual(iterations, 0)
        cancelled = false
        FocusNotificationStream.runWhileActive(isCancelled: { cancelled }) { interval in
            // Models a stop arriving after the cancellation check but before
            // RunInMode enters: a lost Stop wakeup still has a bounded timeout.
            cancelled = true
            XCTAssertLessThanOrEqual(interval, 0.1)
            iterations += 1
            return .timedOut
        }
        XCTAssertEqual(iterations, 1)
    }

    func testExpiredOtherPIDDoesNotPreventHealthyTargetFromRestarting() {
        let stream = FakeStream()
        let live = OSAllocatedUnfairLock(initialState: Set<pid_t>([42, 77]))
        let monitor = FocusEventMonitor(
            helperPID: 700, readInitialFocus: { 9 }, makeStream: { stream },
            releaseFocus: { _ in true }, isOrdinaryApp: { _ in true },
            readProcessIdentity: { pid in
                live.withLock { $0.contains(pid) } ? .init(executablePath: "/test/\(pid)", launchTime: 1) : nil
            }
        )
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        XCTAssertTrue(monitor.register(pid: 77) { _ in })
        live.withLock { _ = $0.remove(77) }
        stream.interrupted?("event_tap_timeout")
        stream.addHook = { $0 != 77 }
        XCTAssertTrue(monitor.register(pid: 42) { _ in })
        XCTAssertNotNil(monitor.registrationReceipt(pid: 42))
        XCTAssertNil(monitor.registrationReceipt(pid: 77))
    }

    func testCallbackUnregisterInvalidatesRemainingEffectsFromThatEvent() {
        let stream = FakeStream()
        let monitor = monitor(stream)
        let gained = OSAllocatedUnfairLock(initialState: [Bool]())
        XCTAssertTrue(monitor.register(pid: 9) { [weak monitor] _ in monitor?.unregisterAll() })
        XCTAssertTrue(monitor.register(pid: 42) { value in gained.withLock { $0.append(value) } })
        XCTAssertEqual(stream.receive?(event()), .pass)
        XCTAssertEqual(gained.withLock { $0 }, [])
        XCTAssertFalse(monitor.diagnostic.available)
    }
}
