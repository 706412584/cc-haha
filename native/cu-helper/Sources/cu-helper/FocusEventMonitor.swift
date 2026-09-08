import AppKit
import Carbon
import CoreGraphics
import Darwin
import Foundation

/// Focus protection for regular/accessory processes whose PID is the owner.
/// The reference normalizes activationPolicy.prohibited / ViewBridge-owned
/// processes through AX metadata. That branch is not implemented here, so
/// prohibited targets are rejected and unknown notification shapes pass through.
final class FocusEventMonitor: @unchecked Sendable {
    typealias FocusChanged = @Sendable (Bool) -> Void
    static let shared = FocusEventMonitor()

    struct Event: Equatable, Sendable {
        let type: UInt32
        let subtype: Int64
        let sourcePID: pid_t
        let targetPID: pid_t
        let focusPID: pid_t
        let focusToken: Int64
    }

    struct Diagnostic: Equatable, Sendable {
        var available = false
        var reason = "not_started"
        var continuityGeneration: UInt64 = 0
        var lastEvent: Event?
    }

    struct ProcessIdentity: Equatable, Sendable {
        let executablePath: String
        let launchTime: TimeInterval
    }

    struct RegistrationReceipt: Equatable, Sendable {
        let pid: pid_t
        fileprivate let generation: UInt64
        fileprivate let identity: ProcessIdentity
    }

    enum Disposition: Equatable, Sendable {
        case pass
        case suppress
        case redirect(pid_t)
    }

    struct ProtectionPolicy: Sendable {
        struct Pending: Equatable, Sendable {
            let thief: pid_t
            let victim: pid_t
            var released = false
            var returnedSeen = false
        }

        struct Effect: Sendable {
            var disposition: Disposition = .pass
            var releaseToken: UInt32?
            var focusChanges: [(pid_t, Bool)] = []
        }

        var focusedPID: pid_t?
        private(set) var pending: Pending?

        mutating func consume(
            _ event: Event, helperPID: pid_t, protectedPIDs: Set<pid_t>,
            realFrontmostPID: pid_t?, isSystemObserver: Bool
        ) -> Effect {
            var effect = Effect()
            // A real user activation wins over every synthetic focus lease.
            if let pending, realFrontmostPID != pending.victim { self.pending = nil }
            if [UInt32(10), 11, 12].contains(event.type) {
                guard event.sourcePID != helperPID else { return effect }
                if let pending, event.targetPID == pending.thief,
                   protectedPIDs.contains(pending.thief), realFrontmostPID == pending.victim {
                    effect.disposition = .redirect(pending.victim)
                }
                return effect
            }
            guard event.type == 21 else { return effect }
            // CPS-generated system notifications can retain our source PID.
            // Their recipient/transaction identifies them; the self-source
            // exemption belongs only to the PID-directed keyboard tap above.
            switch event.subtype {
            case 0x4000:
                guard protectedPIDs.contains(event.focusPID), event.focusPID != focusedPID,
                      event.targetPID == focusedPID, event.targetPID == realFrontmostPID,
                      event.targetPID > 0, event.focusPID != realFrontmostPID else {
                    pending = nil
                    return effect
                }
                pending = Pending(thief: event.focusPID, victim: event.targetPID)
                effect.disposition = .suppress
            case 0x8000:
                if var pending, pending.victim == event.targetPID, !pending.returnedSeen {
                    pending.returnedSeen = true
                    self.pending = pending
                    effect.disposition = .suppress
                }
            case 0xf102:
                guard isSystemObserver, event.focusPID > 0 else { return effect }
                let previous = focusedPID
                focusedPID = event.focusPID
                if previous != event.focusPID {
                    if let previous, previous != pending?.thief {
                        effect.focusChanges.append((previous, false))
                    }
                    if event.focusPID != pending?.thief {
                        effect.focusChanges.append((event.focusPID, true))
                    }
                }
                if var pending {
                    if event.focusPID == pending.thief, !pending.released {
                        pending.released = true
                        self.pending = pending
                        // Zero is not a known transaction. Invalid tokens fail
                        // the controller rather than call an undocumented API.
                        effect.releaseToken = UInt32(exactly: event.focusToken) ?? 0
                    } else if event.focusPID != pending.thief && event.focusPID != pending.victim {
                        self.pending = nil
                    }
                }
            case 2:
                if isSystemObserver, event.focusPID == pending?.thief { pending = nil }
            default:
                break
            }
            return effect
        }

        mutating func invalidate() { focusedPID = nil; pending = nil }
    }

    protocol Stream: AnyObject, Sendable {
        func start(
            receive: @escaping @Sendable (Event) -> Disposition,
            interrupted: @escaping @Sendable (String) -> Void
        ) -> Bool
        func addProtectedPID(_ pid: pid_t) -> Bool
        func stop()
    }

    private struct KeyboardRecovery: Equatable {
        let thief: pid_t
        let victim: pid_t
        let thiefIdentity: ProcessIdentity
        let victimIdentity: ProcessIdentity
        var canForward = true
    }

    private struct State {
        var callbacks: [pid_t: FocusChanged] = [:]
        var identities: [pid_t: ProcessIdentity] = [:]
        var policy = ProtectionPolicy()
        var pendingIdentity: KeyboardRecovery?
        var recovery: KeyboardRecovery?
        var stream: (any Stream)?
        var generation: UInt64 = 0
        var diagnostic = Diagnostic()
    }

    private let lock = NSLock()
    private var state = State()
    private let helperPID: pid_t
    private let readInitialFocus: @Sendable () -> pid_t?
    private let isFocusObserver: @Sendable (pid_t) -> Bool
    private let makeStream: @Sendable () -> any Stream
    private let releaseFocus: (@Sendable (UInt32) -> Bool)?
    private let readRealFrontmost: @Sendable () -> pid_t?
    private let isOrdinaryApp: @Sendable (pid_t) -> Bool
    private let readProcessIdentity: @Sendable (pid_t) -> ProcessIdentity?

    init(
        helperPID: pid_t = getpid(),
        readInitialFocus: @escaping @Sendable () -> pid_t? = FocusEventMonitor.systemFocusPID,
        isFocusObserver: @escaping @Sendable (pid_t) -> Bool = FocusEventMonitor.isViewBridge,
        makeStream: @escaping @Sendable () -> any Stream = { FocusNotificationStream() },
        releaseFocus: (@Sendable (UInt32) -> Bool)? = FocusEventMonitor.systemReleaseFocus,
        readRealFrontmost: @escaping @Sendable () -> pid_t? = {
            NSWorkspace.shared.frontmostApplication?.processIdentifier
        },
        isOrdinaryApp: @escaping @Sendable (pid_t) -> Bool = {
            guard let app = NSRunningApplication(processIdentifier: $0) else { return false }
            return app.activationPolicy != .prohibited
        },
        readProcessIdentity: @escaping @Sendable (pid_t) -> ProcessIdentity? = {
            guard let app = NSRunningApplication(processIdentifier: $0),
                  let executable = app.executableURL?.path, let launch = app.launchDate else { return nil }
            return ProcessIdentity(executablePath: executable, launchTime: launch.timeIntervalSince1970)
        }
    ) {
        self.helperPID = helperPID
        self.readInitialFocus = readInitialFocus
        self.isFocusObserver = isFocusObserver
        self.makeStream = makeStream
        self.releaseFocus = releaseFocus
        self.readRealFrontmost = readRealFrontmost
        self.isOrdinaryApp = isOrdinaryApp
        self.readProcessIdentity = readProcessIdentity
    }

    deinit { state.stream?.stop() }

    var diagnostic: Diagnostic { lock.withLock { state.diagnostic } }

    /// Requires both cancellation SPI and a working PID keyboard tap before
    /// enabling suppression for this target. A failed cancellation blocks new
    /// input while the existing transaction's keyboard routing drains safely.
    @discardableResult
    func register(pid: pid_t, onFocusChanged: @escaping FocusChanged) -> Bool {
        _ = recoveryDisposition(nil, realFrontmost: readRealFrontmost())
        guard lock.withLock({ state.recovery == nil }) else { return false }
        guard pid > 0, isOrdinaryApp(pid), releaseFocus != nil,
              let identity = readProcessIdentity(pid) else {
            lock.withLock { state.diagnostic.reason = "focus_protection_unsupported" }
            return false
        }
        let previousIdentity = lock.withLock { (state.identities[pid], state.generation) }
        if let previous = previousIdentity.0, previous != identity {
            interrupt("target_process_identity_changed", generation: previousIdentity.1)
        }
        let existing = lock.withLock {
            state.diagnostic.available ? state.stream.map { ($0, state.generation) } : nil
        }
        if let (existing, generation) = existing {
            guard existing.addProtectedPID(pid) else {
                interrupt("pid_keyboard_tap_unavailable", generation: generation)
                return false
            }
            guard readProcessIdentity(pid) == identity else {
                interrupt("target_process_identity_changed", generation: generation)
                return false
            }
            return lock.withLock {
                guard state.generation == generation, state.diagnostic.available,
                      state.stream === existing else { return false }
                state.callbacks[pid] = onFocusChanged
                state.identities[pid] = identity
                return true
            }
        }
        let startup = lock.withLock { () -> ((any Stream)?, UInt64)? in
            guard state.recovery == nil else { return nil }
            state.callbacks[pid] = onFocusChanged
            state.identities[pid] = identity
            if state.diagnostic.available { return nil }
            let previous = state.stream
            state.generation &+= 1
            state.diagnostic.continuityGeneration &+= 1
            state.stream = nil
            state.policy.invalidate()
            state.pendingIdentity = nil
            state.diagnostic.reason = "starting"
            return (previous, state.generation)
        }
        guard let (previous, generation) = startup else {
            return lock.withLock {
                state.diagnostic.available && state.identities[pid] == identity
                    && state.callbacks[pid] != nil
            }
        }
        previous?.stop()
        let initialFocus = readInitialFocus()
        let stream = makeStream()
        let installed = lock.withLock { () -> Bool in
            guard state.generation == generation else { return false }
            state.stream = stream
            state.policy.focusedPID = initialFocus
            return true
        }
        guard installed else { stream.stop(); return false }
        let started = stream.start(
            receive: { [weak self] event in self?.receive(event, generation: generation) ?? .pass },
            interrupted: { [weak self] reason in self?.interrupt(reason, generation: generation) }
        )
        let identities = lock.withLock { state.identities }
        let expired = identities.filter { readProcessIdentity($0.key) != $0.value }
        let pids = lock.withLock { () -> [pid_t] in
            guard state.generation == generation else { return [] }
            for (expiredPID, expected) in expired where state.identities[expiredPID] == expected {
                state.identities.removeValue(forKey: expiredPID)
                state.callbacks.removeValue(forKey: expiredPID)
            }
            return Array(state.callbacks.keys)
        }
        let keyboardReady = started && pids.allSatisfy { stream.addProtectedPID($0) }
        let confirmedInitialFocus = readInitialFocus()
        let confirmedTargetIdentity = readProcessIdentity(pid)
        let available = lock.withLock {
            guard state.generation == generation else { return false }
            // An interruption during startup must not be overwritten as healthy.
            guard keyboardReady, confirmedInitialFocus != nil, confirmedTargetIdentity == identity,
                  state.identities[pid] == identity,
                  state.diagnostic.reason == "starting" else {
                if state.diagnostic.reason == "starting" {
                    state.diagnostic.reason = "event_tap_unavailable"
                    state.policy.invalidate()
                }
                return false
            }
            state.policy.focusedPID = confirmedInitialFocus
            state.diagnostic.available = true
            state.diagnostic.reason = "protecting_ordinary_apps"
            return true
        }
        if !available { stream.stop() }
        return available
    }

    func isAppCurrentlyFocused(pid: pid_t) -> Bool {
        lock.withLock { state.diagnostic.available && state.policy.focusedPID == pid }
    }

    func registrationReceipt(pid: pid_t) -> RegistrationReceipt? {
        guard let identity = readProcessIdentity(pid) else { return nil }
        return lock.withLock {
            guard state.diagnostic.available, state.identities[pid] == identity,
                  state.callbacks[pid] != nil else { return nil }
            return RegistrationReceipt(pid: pid, generation: state.generation, identity: identity)
        }
    }

    func isRegistrationCurrent(_ receipt: RegistrationReceipt) -> Bool {
        guard readProcessIdentity(receipt.pid) == receipt.identity else { return false }
        return lock.withLock {
            state.diagnostic.available && state.generation == receipt.generation
                && state.identities[receipt.pid] == receipt.identity && state.callbacks[receipt.pid] != nil
        }
    }

    /// A synchronous workspace activation observer can invalidate a pending
    /// redirect immediately; the event callback also checks the live front PID.
    func observeRealFrontmost(pid: pid_t?) {
        if recoveryDisposition(nil, realFrontmost: pid) != nil { return }
        lock.withLock {
            guard state.policy.pending != nil else { return }
            _ = state.policy.consume(
                Event(type: 0, subtype: 0, sourcePID: helperPID,
                      targetPID: 0, focusPID: 0, focusToken: 0),
                helperPID: helperPID, protectedPIDs: Set(state.callbacks.keys),
                realFrontmostPID: pid, isSystemObserver: false
            )
            if state.policy.pending == nil { state.pendingIdentity = nil }
        }
    }

    func unregisterAll() {
        let stream = lock.withLock { () -> (any Stream)? in
            let previous = state.stream
            // Cancellation runs outside this lock. Teardown during that call
            // must not dismantle the only route back to the user's keyboard.
            if state.recovery == nil, state.policy.pending?.released == true,
               state.policy.focusedPID == state.pendingIdentity?.thief {
                state.recovery = state.pendingIdentity
            }
            state.callbacks.removeAll()
            state.identities.removeAll()
            state.policy.invalidate()
            state.pendingIdentity = nil
            state.diagnostic.available = false
            state.diagnostic.continuityGeneration &+= 1
            if state.recovery != nil {
                state.diagnostic.reason = state.recovery?.canForward == true
                    ? "stopped_waiting_for_keyboard_recovery"
                    : "stopped_keyboard_safety_forwarding_unavailable"
                return nil
            }
            state.generation &+= 1
            state.stream = nil
            state.diagnostic.reason = "stopped"
            return previous
        }
        stream?.stop()
    }

    private func receive(_ event: Event, generation: UInt64) -> Disposition {
        let realFrontmost = readRealFrontmost()
        let observer = event.type == 21 && [Int64(0xf102), 2].contains(event.subtype)
            && isFocusObserver(event.targetPID)
        if let disposition = recoveryDisposition(
            event, generation: generation, realFrontmost: realFrontmost, observer: observer
        ) { return disposition }
        let candidate = event.type == 21 ? event.focusPID : event.targetPID
        if let expected = lock.withLock({ state.identities[candidate] }),
           readProcessIdentity(candidate) != expected {
            interrupt("target_process_identity_changed", generation: generation)
            return .pass
        }
        let victimIdentity = event.type == 21 && event.subtype == 0x4000
            ? readProcessIdentity(event.targetPID) : nil
        let result = lock.withLock { () -> (ProtectionPolicy.Effect, [(FocusChanged, Bool)]) in
            guard state.generation == generation, state.diagnostic.available else { return (.init(), []) }
            state.diagnostic.lastEvent = event
            var effect = state.policy.consume(
                event, helperPID: helperPID, protectedPIDs: Set(state.callbacks.keys),
                realFrontmostPID: realFrontmost, isSystemObserver: observer
            )
            if event.type == 21, event.subtype == 0x4000,
               let pending = state.policy.pending {
                if let thiefIdentity = state.identities[pending.thief], let victimIdentity {
                    state.pendingIdentity = KeyboardRecovery(
                        thief: pending.thief, victim: pending.victim,
                        thiefIdentity: thiefIdentity, victimIdentity: victimIdentity
                    )
                } else {
                    // Without both identities, suppression would create a
                    // transaction that cannot be safely routed after failure.
                    state.policy = ProtectionPolicy(focusedPID: state.policy.focusedPID)
                    effect = .init()
                }
            }
            if state.policy.pending == nil { state.pendingIdentity = nil }
            let callbacks = effect.focusChanges.compactMap { pid, value in
                state.callbacks[pid].map { ($0, value) }
            }
            return (effect, callbacks)
        }
        guard lock.withLock({ state.generation == generation && state.diagnostic.available }) else { return .pass }
        if let token = result.0.releaseToken,
           token == 0 || releaseFocus?(token) != true {
            retainKeyboardRecovery(generation: generation)
            return .pass
        }
        // Never invoke arbitrary caller code under the state lock.
        for (callback, focused) in result.1 {
            guard lock.withLock({ state.generation == generation && state.diagnostic.available }) else { return .pass }
            callback(focused)
        }
        return lock.withLock {
            state.generation == generation && state.diagnostic.available ? result.0.disposition : .pass
        }
    }

    /// A cancellation error invalidates automation, not the already-proven
    /// keyboard route. Only that route survives; system notifications all pass.
    private func retainKeyboardRecovery(generation: UInt64) {
        let callbacks = lock.withLock { () -> [FocusChanged] in
            guard state.generation == generation else { return [] }
            if state.recovery == nil { state.recovery = state.pendingIdentity }
            state.diagnostic.available = false
            state.diagnostic.reason = state.recovery?.canForward == true
                ? "release_key_focus_failed_waiting_for_keyboard_recovery"
                : "release_key_focus_failed_keyboard_safety_forwarding_unavailable"
            state.diagnostic.continuityGeneration &+= 1
            state.policy.invalidate()
            state.pendingIdentity = nil
            return Array(state.callbacks.values)
        }
        for callback in callbacks { callback(false) }
    }

    /// nil means no recovery owns this event. A nil front PID/identity is not
    /// evidence of restoration: stop routing for that event, but keep input
    /// blocked until a positive foreground/focus/identity transition is seen.
    private func recoveryDisposition(
        _ event: Event?, generation: UInt64? = nil,
        realFrontmost: pid_t?, observer: Bool = false
    ) -> Disposition? {
        let snapshot = lock.withLock { () -> (KeyboardRecovery, UInt64)? in
            guard generation == nil || state.generation == generation,
                  let recovery = state.recovery else { return nil }
            return (recovery, state.generation)
        }
        guard let (recovery, ownerGeneration) = snapshot else { return nil }
        let thiefIdentity = readProcessIdentity(recovery.thief)
        let victimIdentity = readProcessIdentity(recovery.victim)
        let frontChanged = realFrontmost.map { $0 > 0 && $0 != recovery.victim } ?? false
        let identityChanged = thiefIdentity.map { $0 != recovery.thiefIdentity } == true
            || victimIdentity.map { $0 != recovery.victimIdentity } == true
        let focusRestored = event.map {
            observer && $0.type == 21 && $0.subtype == 0xf102
                && $0.focusPID > 0 && $0.focusPID != recovery.thief
        } ?? false
        let result = lock.withLock { () -> (Disposition, (any Stream)?) in
            guard state.generation == ownerGeneration, state.recovery == recovery else { return (.pass, nil) }
            if let event { state.diagnostic.lastEvent = event }
            if frontChanged || identityChanged || focusRestored {
                let previous = state.stream
                state.stream = nil
                state.recovery = nil
                state.pendingIdentity = nil
                state.policy.invalidate()
                state.generation &+= 1
                state.diagnostic.continuityGeneration &+= 1
                state.diagnostic.reason = identityChanged
                    ? "keyboard_recovery_process_identity_changed" : "keyboard_focus_recovery_observed"
                return (.pass, previous)
            }
            guard recovery.canForward, let event, [UInt32(10), 11, 12].contains(event.type),
                  event.sourcePID != helperPID, event.targetPID == recovery.thief,
                  realFrontmost == recovery.victim,
                  thiefIdentity == recovery.thiefIdentity,
                  victimIdentity == recovery.victimIdentity else { return (.pass, nil) }
            return (.redirect(recovery.victim), nil)
        }
        result.1?.stop()
        return result.0
    }

    private func interrupt(_ reason: String, generation: UInt64) {
        let result = lock.withLock { () -> ([FocusChanged], (any Stream)?) in
            guard state.generation == generation else { return ([], nil) }
            state.diagnostic.available = false
            if state.recovery == nil, state.policy.pending?.released == true {
                state.recovery = state.pendingIdentity
            }
            // Once macOS disables a tap we cannot promise keyboard delivery.
            // Keep new automation blocked until the unsafe focus window ends.
            state.recovery?.canForward = false
            state.diagnostic.reason = state.recovery == nil
                ? reason : "\(reason)_keyboard_safety_forwarding_unavailable"
            state.diagnostic.continuityGeneration &+= 1
            state.policy.invalidate()
            state.pendingIdentity = nil
            return (Array(state.callbacks.values), state.stream)
        }
        result.1?.stop()
        for callback in result.0 { callback(false) }
    }

    private typealias GetKeyFocus = @convention(c) (
        UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutablePointer<DarwinBoolean>
    ) -> OSStatus

    private static let getKeyFocus: GetKeyFocus? = {
        guard let handle = dlopen(nil, RTLD_LAZY),
              let symbol = dlsym(handle, "CPSGetKeyFocusProcess") else { return nil }
        return unsafeBitCast(symbol, to: GetKeyFocus.self)
    }()

    private typealias GetPID = @convention(c) (
        UnsafePointer<ProcessSerialNumber>, UnsafeMutablePointer<pid_t>
    ) -> OSStatus

    private static let getPID: GetPID? = {
        guard let handle = dlopen(nil, RTLD_LAZY),
              let symbol = dlsym(handle, "GetProcessPID") else { return nil }
        return unsafeBitCast(symbol, to: GetPID.self)
    }()

    private typealias ReleaseFocus = @convention(c) (UInt32) -> OSStatus
    private static let systemReleaseFocus: (@Sendable (UInt32) -> Bool)? = {
        guard let handle = dlopen(nil, RTLD_LAZY),
              let symbol = dlsym(handle, "CPSReleaseKeyFocusWithID") else { return nil }
        let release = unsafeBitCast(symbol, to: ReleaseFocus.self)
        return { release($0) == noErr }
    }()

    private static func systemFocusPID() -> pid_t? {
        var process = ProcessSerialNumber()
        var focused = DarwinBoolean(false)
        var pid: pid_t = 0
        if let getKeyFocus, let getPID, getKeyFocus(&process, &focused) == noErr,
           getPID(&process, &pid) == noErr, pid > 0 { return pid }
        // Older systems can lack the SPI. Public frontmost process is an initial
        // fallback only; synthetic per-process notifications never overwrite it.
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    private static func isViewBridge(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        var name = [CChar](repeating: 0, count: 256)
        if proc_name(pid, &name, UInt32(name.count)) > 0 {
            return name.withUnsafeBufferPointer { buffer in
                guard let base = buffer.baseAddress else { return false }
                return isViewBridgeProcess(name: String(cString: base), executablePath: nil)
            }
        }
        // A root-owned ViewBridge is visible to proc_pidpath even when
        // proc_name is unreadable. Accept only the observed system executable,
        // not another app or bundle with the same last path component.
        var path = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return false }
        return path.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return false }
            return isViewBridgeProcess(name: nil, executablePath: String(cString: base))
        }
    }

    static func isViewBridgeProcess(name: String?, executablePath: String?) -> Bool {
        if let name { return name == "ViewBridgeAuxiliary" }
        return executablePath == "/System/Library/PrivateFrameworks/ViewBridge.framework/Versions/A/XPCServices/ViewBridgeAuxiliary.xpc/Contents/MacOS/ViewBridgeAuxiliary"
    }
}

final class FocusNotificationStream: FocusEventMonitor.Stream, @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var runLoop: CFRunLoop?
    private var tap: CFMachPort?
    private var keyboardTaps: [pid_t: CFMachPort] = [:]
    private var keyboardSources: [CFRunLoopSource] = []
    private var receive: (@Sendable (FocusEventMonitor.Event) -> FocusEventMonitor.Disposition)?
    private var interrupted: (@Sendable (String) -> Void)?

    private typealias CreatePIDTap = @convention(c) (
        pid_t, UInt32, UInt32, CGEventMask, CGEventTapCallBack, UnsafeMutableRawPointer?
    ) -> Unmanaged<CFMachPort>?
    private static let createPIDTap: CreatePIDTap? = {
        guard let handle = dlopen(nil, RTLD_LAZY),
              let symbol = dlsym(handle, "CGEventTapCreateForPid") else { return nil }
        return unsafeBitCast(symbol, to: CreatePIDTap.self)
    }()

    private static let callback: CGEventTapCallBack = { _, type, event, context in
        guard let context else { return Unmanaged.passUnretained(event) }
        let stream = Unmanaged<FocusNotificationStream>.fromOpaque(context).takeUnretainedValue()
        switch stream.handle(type: type, event: event) {
        case .pass: return Unmanaged.passUnretained(event)
        case .suppress: return nil
        case .redirect(let victim):
            event.postToPid(victim)
            return nil
        }
    }

    func start(
        receive: @escaping @Sendable (FocusEventMonitor.Event) -> FocusEventMonitor.Disposition,
        interrupted: @escaping @Sendable (String) -> Void
    ) -> Bool {
        lock.withLock { self.receive = receive; self.interrupted = interrupted }
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [self] in run(ready: ready) }
        thread.name = "computer-use-focus-observer"
        thread.start()
        guard ready.wait(timeout: .now() + 1) == .success else {
            interrupted("event_tap_start_timeout")
            stop()
            return false
        }
        return lock.withLock { !cancelled && tap != nil }
    }

    func addProtectedPID(_ pid: pid_t) -> Bool {
        guard Self.createPIDTap != nil else { return false }
        let loop = lock.withLock { cancelled ? nil : runLoop }
        guard let loop else { return false }
        guard Self.perform(on: loop, operation: { [weak self] in
            self?.installKeyboardTap(pid, loop: CFRunLoopGetCurrent())
        }) else {
            interrupted?("pid_keyboard_tap_start_timeout")
            stop()
            return false
        }
        return lock.withLock { !cancelled && keyboardTaps[pid] != nil }
    }

    /// A callback already executes on this run loop; waiting for a queued block
    /// there would block the very worker responsible for acknowledging it.
    static func perform(on loop: CFRunLoop, operation: @escaping @Sendable () -> Void) -> Bool {
        if CFEqual(CFRunLoopGetCurrent(), loop) { operation(); return true }
        let ready = DispatchSemaphore(value: 0)
        CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) {
            operation()
            ready.signal()
        }
        CFRunLoopWakeUp(loop)
        return ready.wait(timeout: .now() + 1) == .success
    }

    static func runWhileActive(
        isCancelled: () -> Bool,
        runOnce: (TimeInterval) -> CFRunLoopRunResult = {
            CFRunLoopRunInMode(.defaultMode, $0, false)
        }
    ) {
        while !isCancelled() {
            if runOnce(0.1) == .finished { break }
        }
    }

    private func installKeyboardTap(_ pid: pid_t, loop: CFRunLoop) {
        guard lock.withLock({ !cancelled && keyboardTaps[pid] == nil }),
              let create = Self.createPIDTap,
              let port = create(
                pid, CGEventTapPlacement.tailAppendEventTap.rawValue,
                CGEventTapOptions.defaultTap.rawValue, 0x1c00, Self.callback,
                Unmanaged.passUnretained(self).toOpaque()
              )?.takeRetainedValue() else { return }
        guard let source = CFMachPortCreateRunLoopSource(nil, port, 0) else {
            CFMachPortInvalidate(port)
            return
        }
        CFRunLoopAddSource(loop, source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        let installed = lock.withLock { () -> Bool in
            guard !cancelled, CGEvent.tapIsEnabled(tap: port) else { return false }
            keyboardTaps[pid] = port
            keyboardSources.append(source)
            return true
        }
        if !installed {
            CFRunLoopRemoveSource(loop, source, .commonModes)
            CFMachPortInvalidate(port)
        }
    }

    func stop() {
        let loop = lock.withLock { () -> CFRunLoop? in
            cancelled = true
            return runLoop
        }
        if let loop { CFRunLoopStop(loop); CFRunLoopWakeUp(loop) }
    }

    private func run(ready: DispatchSemaphore) {
        guard let port = CGEvent.tapCreate(
            tap: .cgAnnotatedSessionEventTap,
            place: .tailAppendEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(1) << 21,
            callback: Self.callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            interrupted?("event_tap_creation_failed_permission_or_unsupported")
            ready.signal()
            return
        }
        guard let source = CFMachPortCreateRunLoopSource(nil, port, 0) else {
            CFMachPortInvalidate(port)
            interrupted?("event_tap_run_loop_source_failed")
            ready.signal()
            return
        }
        let loop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(loop, source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        let shouldRun = lock.withLock { () -> Bool in
            guard !cancelled, CGEvent.tapIsEnabled(tap: port) else { return false }
            tap = port
            runLoop = loop
            return true
        }
        ready.signal()
        if shouldRun {
            // Stop can race the gap before RunInMode enters. A bounded run keeps
            // that lost wakeup from leaving the worker and its taps alive forever.
            Self.runWhileActive(isCancelled: { lock.withLock { cancelled } })
        }
        let keyboards = lock.withLock { () -> ([CFMachPort], [CFRunLoopSource]) in
            let owned = (Array(keyboardTaps.values), keyboardSources)
            keyboardTaps.removeAll()
            keyboardSources.removeAll()
            return owned
        }
        for source in keyboards.1 { CFRunLoopRemoveSource(loop, source, .commonModes) }
        for port in keyboards.0 { CFMachPortInvalidate(port) }
        CGEvent.tapEnable(tap: port, enable: false)
        CFRunLoopRemoveSource(loop, source, .commonModes)
        CFMachPortInvalidate(port)
        let unexpected = lock.withLock { () -> Bool in
            tap = nil
            runLoop = nil
            return !cancelled
        }
        if unexpected { interrupted?("event_tap_run_loop_stopped") }
    }

    private func handle(type: CGEventType, event: CGEvent) -> FocusEventMonitor.Disposition {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            interrupted?(type == .tapDisabledByTimeout ? "event_tap_timeout" : "event_tap_disabled")
            // The next registration creates a fresh stream and fresh initial
            // focus. Re-enabling here would pretend the missed interval was safe.
            stop()
            return .pass
        }
        guard [UInt32(21), 10, 11, 12].contains(type.rawValue),
              let subtypeField = CGEventField(rawValue: 64),
              let focusField = CGEventField(rawValue: 73),
              let tokenField = CGEventField(rawValue: 71) else { return .pass }
        return receive?(FocusEventMonitor.Event(
            type: type.rawValue,
            subtype: event.getIntegerValueField(subtypeField),
            sourcePID: pid_t(truncatingIfNeeded: event.getIntegerValueField(.eventSourceUnixProcessID)),
            targetPID: pid_t(truncatingIfNeeded: event.getIntegerValueField(.eventTargetUnixProcessID)),
            focusPID: pid_t(truncatingIfNeeded: event.getIntegerValueField(focusField)),
            focusToken: event.getIntegerValueField(tokenField)
        )) ?? .pass
    }
}
