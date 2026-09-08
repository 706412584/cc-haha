import CoreGraphics
import XCTest

@testable import cc_haha_computer_use

/// The monitor is a permission-free read over the session's HID event
/// counters. What must hold:
///  - the epoch is the sum over the DECLARED physical set, so any single
///    counter moving changes the epoch;
///  - identical reads produce identical epochs (stability is meaningful);
///  - the source is constitutively available with constant continuity, because
///    a counter read cannot be disabled or interrupted — this is the property
///    that fixed "every action fails focus_isolation_unavailable on a fresh
///    install" (the old listen-only tap needed an Input Monitoring grant that
///    onboarding never requested).
final class PhysicalInputEpochMonitorTests: XCTestCase {
    /// Injected events still carry the helper marker. The counter monitor does
    /// not need it (postToPid events do not reach the HID counters at all),
    /// but the marker remains the provenance stamp that lets ANY observer —
    /// diagnostics, external taps, future filters — tell agent input from
    /// human input.
    @MainActor
    func testEveryHelperEventSourceCarriesOneStableNonzeroMarker() throws {
        XCTAssertNotEqual(HelperEventMarker.value, 0)

        let injectionSource = try XCTUnwrap(Injection.source)
        let actionSource = try XCTUnwrap(AXAction.eventSource)

        XCTAssertEqual(injectionSource.userData, HelperEventMarker.value)
        XCTAssertEqual(actionSource.userData, HelperEventMarker.value)
        XCTAssertEqual(injectionSource.userData, actionSource.userData)
    }

    /// Fixed counters → fixed epoch, and reading twice changes nothing.
    func testStableCountersProduceAStableEpoch() {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 7 })
        let first = monitor.snapshot
        let second = monitor.snapshot
        XCTAssertEqual(first.epoch, second.epoch)
        XCTAssertEqual(
            first.epoch,
            UInt64(PhysicalInputEpochMonitor.physicalEventTypes.count) * 7
        )
    }

    /// One keystroke = one counter bump = a different epoch. This is the whole
    /// interference signal.
    func testAnySingleCounterBumpChangesTheEpoch() {
        for bumped in PhysicalInputEpochMonitor.physicalEventTypes {
            let before = PhysicalInputEpochMonitor(counterReader: { _ in 3 })
            let after = PhysicalInputEpochMonitor(counterReader: { type in
                type == bumped ? 4 : 3
            })
            XCTAssertNotEqual(
                before.snapshot.epoch,
                after.snapshot.epoch,
                "bump of \(bumped) must be observable"
            )
        }
    }

    /// The physical set covers every input class the old tap mask watched
    /// except plain motion: presses, releases, drags, keys, modifiers, and
    /// scroll. `.mouseMoved` is deliberately excluded because moving the cursor
    /// is not an interaction with any app, and counting it aborted background
    /// automation whenever the user moved their mouse.
    func testPhysicalSetCoversAllInputClasses() {
        let set = Set(PhysicalInputEpochMonitor.physicalEventTypes.map(\.rawValue))
        let required: [CGEventType] = [
            .leftMouseDown, .leftMouseUp,
            .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .keyDown, .keyUp, .flagsChanged,
            .scrollWheel,
        ]
        for type in required {
            XCTAssertTrue(set.contains(type.rawValue), "missing \(type)")
        }
        // And nothing extra: a type outside this set would break the
        // "equal epochs ⇔ no physical input" equivalence the lease relies on.
        XCTAssertEqual(set.count, required.count)
        XCTAssertFalse(
            set.contains(CGEventType.mouseMoved.rawValue),
            "plain mouse movement must not count as interference"
        )
    }

    /// Counter reads cannot fail, so availability is constant and continuity
    /// never advances. `ForegroundLease.acquire` consumes exactly these fields.
    func testSourceIsConstitutivelyAvailable() {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 0 })
        let snapshot = monitor.snapshot
        XCTAssertTrue(snapshot.available)
        XCTAssertEqual(snapshot.continuityGeneration, 0)
    }

    /// Extreme counters must not trap: 13 × UInt32.max fits comfortably in
    /// UInt64, so the sum is exact — no overflow, no saturation.
    func testMaximumCountersDoNotOverflow() {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in .max })
        XCTAssertEqual(
            monitor.snapshot.epoch,
            UInt64(PhysicalInputEpochMonitor.physicalEventTypes.count)
                * UInt64(UInt32.max)
        )
    }

    /// Call-site compatibility: startAndWait returns a live snapshot and stop
    /// is an idempotent no-op — the daemon and one-shot paths call both.
    func testLifecycleShimsAreHarmless() {
        let monitor = PhysicalInputEpochMonitor(counterReader: { _ in 5 })
        let started = monitor.startAndWait()
        XCTAssertTrue(started.available)
        XCTAssertEqual(started.epoch, monitor.snapshot.epoch)
        monitor.stop()
        monitor.stop()
        XCTAssertEqual(monitor.snapshot.epoch, started.epoch)
    }

    /// The production reader targets `.hidSystemState` — hardware input. This
    /// is load-bearing twice: no Input Monitoring grant is needed to read it,
    /// and (measured on-device) `CGEvent.postToPid` injection does not move
    /// these counters, so the agent can never trip its own detector. Counters
    /// must never run backwards between two consecutive reads.
    func testSystemReaderReturnsMonotonicallyPlausibleValues() {
        let read = PhysicalInputEpochMonitor.systemCounterReader
        for type in PhysicalInputEpochMonitor.physicalEventTypes {
            let first = read(type)
            let second = read(type)
            XCTAssertGreaterThanOrEqual(
                second,
                first,
                "counter for \(type) went backwards"
            )
        }
    }
}
