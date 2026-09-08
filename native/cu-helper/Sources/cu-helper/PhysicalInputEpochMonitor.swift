import CoreGraphics
import Foundation

/// Immutable lease evidence: an opaque physical-input epoch plus the health of
/// the source that produced it. `ForegroundLease` compares epochs across an
/// action to detect user input that could have interleaved with agent input.
struct PhysicalInputEpochSnapshot: Equatable, Sendable {
    let epoch: UInt64
    let available: Bool
    let continuityGeneration: UInt64

    init(
        epoch: UInt64,
        available: Bool,
        continuityGeneration: UInt64 = 0
    ) {
        self.epoch = epoch
        self.available = available
        self.continuityGeneration = continuityGeneration
    }
}

/// Physical-input epoch source backed by the session's HID event COUNTERS
/// (`CGEventSource.counterForEventType(.hidSystemState, …)`), not an event tap.
///
/// WHY COUNTERS AND NOT A LISTEN-ONLY EVENT TAP
/// --------------------------------------------
/// The first implementation used `CGEvent.tapCreate(.listenOnly)` over all
/// input. A listen-only tap whose mask includes keyboard events requires the
/// Input Monitoring TCC permission — a THIRD permission that onboarding never
/// requested (the card asks for Accessibility + Screen Recording only), so on
/// every fresh install `tapCreate` returned nil, the monitor reported
/// unavailable, and `ForegroundLease.acquire` failed EVERY mutating action
/// with `focus_isolation_unavailable`. Codex ships computer use with no such
/// permission requirement at all; a safety layer that turns the whole product
/// off for correctly-onboarded users is not safety.
///
/// The HID system-state counters give the same signal with no TCC gate:
///  - They are aggregate per-event-type counts, not event contents, so macOS
///    does not gate them behind Input Monitoring (the API dates to 10.4 and is
///    readable from unentitled processes).
///  - They reflect HARDWARE input. Our own injection is exclusively
///    `CGEvent.postToPid` (see Injection.swift), which bypasses the HID
///    stream: measured on-device, posting synthetic events moves neither the
///    `.hidSystemState` nor the `.combinedSessionState` counters. The tap
///    implementation needed a userData marker to filter self-generated events;
///    counters need nothing.
///  - Reads cannot be disabled, time out, or race a run loop, so the tap's
///    continuity accounting (tapDisabledByTimeout → re-enable → generation
///    bump) has nothing left to guard. `available` is constitutively true and
///    `continuityGeneration` is constant 0. `ForegroundLeasePolicy` keeps its
///    unavailability branches because it is a pure function over the evidence
///    shape — they are simply unreachable from this source.
///
/// KNOWN BLIND SPOTS (accepted):
///  - Key AUTOREPEAT events are not counted (documented CG behavior). The
///    initial keyDown of any held key IS counted, so a user who starts typing
///    during an action still bumps the epoch.
///  - A UInt32 counter can in principle wrap mid-action; the summed epoch then
///    changes, which reads as interference — the failure mode is a spurious
///    abort, never a missed abort.
final class PhysicalInputEpochMonitor: @unchecked Sendable {
    typealias CounterReader = @Sendable (CGEventType) -> UInt32

    /// Event types that count as physical input.
    ///
    /// Mirrors the old tap mask for presses, drags, key transitions, modifier
    /// changes, and scroll, but deliberately omits `.mouseMoved`. Moving the
    /// cursor across the screen is not an interaction with any app — the user
    /// can be working in another window while automation runs in the background
    /// — and counting it made every cursor glide abort the action. Dragging is
    /// kept because a drag is an intentional press-and-motion gesture.
    static let physicalEventTypes: [CGEventType] = [
        .leftMouseDown, .leftMouseUp,
        .rightMouseDown, .rightMouseUp,
        .otherMouseDown, .otherMouseUp,
        .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
        .keyDown, .keyUp, .flagsChanged,
        .scrollWheel,
    ]

    /// Production reader: the session's hardware-input counters.
    static let systemCounterReader: CounterReader = { eventType in
        CGEventSource.counterForEventType(.hidSystemState, eventType: eventType)
    }

    private let readCounter: CounterReader

    init(counterReader: @escaping CounterReader = systemCounterReader) {
        self.readCounter = counterReader
    }

    var snapshot: PhysicalInputEpochSnapshot {
        PhysicalInputEpochSnapshot(
            epoch: currentEpoch(),
            available: true,
            continuityGeneration: 0
        )
    }

    /// Kept for call-site compatibility with the old worker-thread monitor.
    /// Counter reads need no startup; this just returns the current snapshot.
    @discardableResult
    func startAndWait() -> PhysicalInputEpochSnapshot { snapshot }

    /// No worker thread to stop. Idempotent no-op.
    func stop() {}

    /// Sum of all physical counters. Counters never decrease (short of a
    /// once-in-years UInt32 wrap), so equal sums ⇔ no physical input between
    /// the two reads. 14 × UInt32.max is far below UInt64.max — the sum cannot
    /// overflow.
    private func currentEpoch() -> UInt64 {
        Self.physicalEventTypes.reduce(UInt64(0)) { sum, eventType in
            sum + UInt64(readCounter(eventType))
        }
    }
}
