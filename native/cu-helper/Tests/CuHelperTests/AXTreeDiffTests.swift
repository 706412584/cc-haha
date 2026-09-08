import XCTest
@testable import cc_haha_computer_use

final class AXTreeDiffTests: XCTestCase {
    private typealias DisplayKey = AXTreeDisplayIdentity<String, String>
    private typealias StableKey = AXTreeStableIdentity<String, DisplayKey>

    private let processA = AXTreeProcessIdentity(
        bundleID: "com.example.app",
        executablePath: "/Applications/Example.app/Contents/MacOS/Example",
        launchTime: 100
    )

    private func line(_ id: Int, _ rendered: String) -> AXTreeDiffLine {
        AXTreeDiffLine(id: id, rendered: rendered)
    }

    private func identity(_ id: Int, _ key: String) -> AXTreeIdentity<String> {
        AXTreeIdentity(id: id, key: key)
    }

    private func displayKey(
        path: [Int],
        role: String = "AXRuler",
        title: String = "Ruler",
        fingerprint: String? = nil
    ) -> DisplayKey {
        AXTreeDisplayIdentity(
            root: "window:42",
            rawPath: path,
            fingerprint: fingerprint ?? "\(role):\(title)",
            role: role,
            title: title,
            depth: 2
        )
    }

    func testChangedAndAddedLinesUseCodexMarkers() throws {
        let old = [
            line(0, "g7:0 window"),
            line(1, "\tg7:1 button A"),
        ]
        let new = [
            line(0, "g7:0 window"),
            line(1, "\tg7:1 button B"),
            line(2, "\tg7:2 button C"),
        ]

        let result = try AXTreeDiff.render(old: old, new: new)

        XCTAssertEqual(result.markedLines, ["~\tg7:1 button B", "+\tg7:2 button C"])
        XCTAssertEqual(result.removedIDs, [])
    }

    func testRemovedIDsAreSummarizedAsDeterministicSparseRanges() throws {
        let old = [0, 1, 2, 4, 7, 8, 9].map { line($0, "g7:\($0) item") }
        let new = [0, 4].map { line($0, "g7:\($0) item") }

        let result = try AXTreeDiff.render(old: old, new: new)

        XCTAssertEqual(result.removedIDs, [1, 2, 7, 8, 9])
        XCTAssertEqual(
            AXTreeDiff.removedIDSummary(result.removedIDs),
            "Removed element IDs: 1-2, 7-9"
        )
    }

    func testNoChangeTextIsExactAndPreservesContextTail() throws {
        let state = [line(0, "g7:0 window")]

        XCTAssertEqual(
            try AXTreeDiff.text(
                old: state,
                new: state,
                windowTitle: "Docs",
                contextTail: ["", "The focused UI element is g7:0 window."]
            ),
            "There has been no change in the accessibility tree for Window: \"Docs\".\n\nThe focused UI element is g7:0 window."
        )
    }

    func testUniqueLocatorRetainsStableIDAcrossFullDiffFullAndValueChangeMarksChanged() throws {
        let initial = try AXTreeDiff.reconcile(
            previous: [],
            current: [identity(0, "window/search")],
            nextID: 0
        )
        XCTAssertEqual(initial.assignments, [0: 0])

        let refreshed = try AXTreeDiff.reconcile(
            previous: [identity(0, "window/search")],
            current: [identity(99, "window/search")],
            nextID: initial.nextID
        )
        XCTAssertEqual(refreshed.assignments, [99: 0])
        XCTAssertEqual(refreshed.nextID, 1)

        let changed = try AXTreeDiff.render(
            old: [line(0, "\tg7:0 text field Value: old")],
            new: [line(0, "\tg7:0 text field Value: new")]
        )
        XCTAssertEqual(changed.markedLines, ["~\tg7:0 text field Value: new"])
    }

    func testAddedIDsAreMonotonicAndRemovedIDsAreNeverReused() throws {
        let first = try AXTreeDiff.reconcile(
            previous: [],
            current: [identity(0, "a"), identity(1, "b")],
            nextID: 0
        )
        XCTAssertEqual(first.assignments, [0: 0, 1: 1])

        let second = try AXTreeDiff.reconcile(
            previous: [identity(0, "a"), identity(1, "b")],
            current: [identity(0, "a"), identity(1, "c")],
            nextID: first.nextID
        )
        XCTAssertEqual(second.assignments, [0: 0, 1: 2])
        XCTAssertEqual(second.nextID, 3)
        XCTAssertTrue(second.containsStableID(0))
        XCTAssertFalse(second.containsStableID(1))
        XCTAssertTrue(second.containsStableID(2))
    }

    func testSameWindowOldHandleRemainsActionableWhileRemovedSparseIDIsRejected() throws {
        let refreshed = try AXTreeDiff.reconcile(
            previous: [identity(0, "kept"), identity(4, "removed")],
            current: [identity(99, "kept")],
            nextID: 5
        )
        let membership = AXTreeHandleMembership(
            snapshotID: 7,
            processIdentity: processA,
            elementIDs: Set(refreshed.assignments.values)
        )

        XCTAssertTrue(membership.contains(
            SnapshotElementHandle(snapshotID: 7, index: 0),
            currentProcessIdentity: processA
        ))
        XCTAssertFalse(membership.contains(
            SnapshotElementHandle(snapshotID: 7, index: 4),
            currentProcessIdentity: processA
        ))
        XCTAssertFalse(membership.contains(
            SnapshotElementHandle(snapshotID: 8, index: 0),
            currentProcessIdentity: processA
        ))
    }

    func testOldHandleRejectsChangedMissingAndUnprovenCurrentProcessIdentity() {
        let membership = AXTreeHandleMembership(
            snapshotID: 7,
            processIdentity: processA,
            elementIDs: [0]
        )
        let handle = SnapshotElementHandle(snapshotID: 7, index: 0)
        let replacement = AXTreeProcessIdentity(
            bundleID: processA.bundleID,
            executablePath: processA.executablePath,
            launchTime: 200
        )
        let unproven = AXTreeProcessIdentity(
            bundleID: nil,
            executablePath: nil,
            launchTime: nil
        )

        XCTAssertFalse(membership.contains(handle, currentProcessIdentity: replacement))
        XCTAssertFalse(membership.contains(handle, currentProcessIdentity: nil))
        XCTAssertFalse(membership.contains(handle, currentProcessIdentity: unproven))
    }

    func testAmbiguousDuplicateLocatorsNeverInheritAnOldID() throws {
        let result = try AXTreeDiff.reconcile(
            previous: [identity(4, "shared-row"), identity(5, "shared-row")],
            current: [identity(0, "shared-row"), identity(1, "shared-row")],
            nextID: 6
        )

        XCTAssertEqual(result.assignments, [0: 6, 1: 7])
        XCTAssertEqual(result.nextID, 8)
    }

    func testReconciliationRejectsDuplicateOldAndCurrentIDs() {
        XCTAssertThrowsError(try AXTreeDiff.reconcile(
            previous: [identity(4, "a"), identity(4, "b")],
            current: [identity(0, "a")],
            nextID: 5
        )) { error in
            XCTAssertEqual(error as? AXTreeReconciliationError, .duplicatePreviousID(4))
        }
        XCTAssertThrowsError(try AXTreeDiff.reconcile(
            previous: [identity(4, "a")],
            current: [identity(0, "a"), identity(0, "b")],
            nextID: 5
        )) { error in
            XCTAssertEqual(error as? AXTreeReconciliationError, .duplicateCurrentID(0))
        }
        XCTAssertThrowsError(try AXTreeDiff.reconcile(
            previous: [],
            current: [identity(0, "new")],
            nextID: Int.max
        )) { error in
            XCTAssertEqual(error as? AXTreeReconciliationError, .stableIDExhausted)
        }
    }

    func testDiffRejectsDuplicateOldAndNewLineIDs() {
        XCTAssertThrowsError(try AXTreeDiff.render(
            old: [line(1, "old-a"), line(1, "old-b")],
            new: []
        )) { error in
            XCTAssertEqual(error as? AXTreeDiffError, .duplicateOldLineID(1))
        }
        XCTAssertThrowsError(try AXTreeDiff.render(
            old: [],
            new: [line(1, "new-a"), line(1, "new-b")]
        )) { error in
            XCTAssertEqual(error as? AXTreeDiffError, .duplicateNewLineID(1))
        }
    }

    func testStableIDIncrementReportsOverflowInsteadOfTrapping() {
        XCTAssertEqual(AXTreeDiff.incrementStableID(41), 42)
        XCTAssertNil(AXTreeDiff.incrementStableID(Int.max))
        XCTAssertEqual(
            AXTreeDiff.removedIDSummary([Int.max, Int.max - 1]),
            "Removed element IDs: \(Int.max - 1)-\(Int.max)"
        )
    }

    func testWarmupCacheReusesOnlyProvenCurrentProcessIdentity() {
        let unproven = AXTreeProcessIdentity(
            bundleID: nil,
            executablePath: nil,
            launchTime: nil
        )
        XCTAssertFalse(AXTreeDiff.shouldWarmAX(cached: processA, current: processA))
        XCTAssertTrue(AXTreeDiff.shouldWarmAX(cached: nil, current: processA))
        XCTAssertTrue(AXTreeDiff.shouldWarmAX(cached: unproven, current: unproven))
    }

    func testIdenticalDisplayOnlyNodesRetainIDsAndRenderNoChange() throws {
        let key = StableKey.displayOnly(displayKey(path: [0, 2]))
        let reconciled = try AXTreeDiff.reconcile(
            previous: [AXTreeIdentity(id: 6, key: key)],
            current: [AXTreeIdentity(id: 90, key: key)],
            nextID: 7
        )

        XCTAssertEqual(reconciled.assignments, [90: 6])
        let stableID = try XCTUnwrap(reconciled.assignments[90])
        let diff = try AXTreeDiff.render(
            old: [line(6, "\tg1:6 ruler Ruler")],
            new: [line(stableID, "\tg1:6 ruler Ruler")]
        )
        XCTAssertTrue(diff.isEmpty)
    }

    func testUnverifiableAuxiliaryRootNeverInheritsDisplayIDsAtTheSameWindowIndex() throws {
        let key = StableKey.transientDisplay(displayKey(path: [0, 2]))
        let reconciled = try AXTreeDiff.reconcile(
            previous: [AXTreeIdentity(id: 6, key: key)],
            current: [AXTreeIdentity(id: 90, key: key)],
            nextID: 7,
            canInherit: { $0.canInheritStableID }
        )

        XCTAssertEqual(reconciled.assignments, [90: 7])
        XCTAssertEqual(reconciled.nextID, 8)
    }

    func testUnverifiableAuxiliaryRootReorderNeverRebindsOldDisplayIDs() throws {
        let first = StableKey.transientDisplay(displayKey(path: [0, 2]))
        let second = StableKey.transientDisplay(displayKey(path: [0, 3]))
        let reconciled = try AXTreeDiff.reconcile(
            previous: [
                AXTreeIdentity(id: 6, key: first),
                AXTreeIdentity(id: 7, key: second),
            ],
            current: [
                AXTreeIdentity(id: 90, key: second),
                AXTreeIdentity(id: 91, key: first),
            ],
            nextID: 8,
            canInherit: { $0.canInheritStableID }
        )

        XCTAssertEqual(reconciled.assignments, [90: 8, 91: 9])
        XCTAssertEqual(reconciled.nextID, 10)
    }

    func testDisplayOnlySiblingInsertionAllocatesNewIDAndRendersRemovedAdded() throws {
        let oldKey = StableKey.displayOnly(displayKey(path: [0, 2]))
        let shiftedKey = StableKey.displayOnly(displayKey(path: [0, 3]))
        let reconciled = try AXTreeDiff.reconcile(
            previous: [AXTreeIdentity(id: 6, key: oldKey)],
            current: [AXTreeIdentity(id: 90, key: shiftedKey)],
            nextID: 7
        )

        XCTAssertEqual(reconciled.assignments, [90: 7])
        let stableID = try XCTUnwrap(reconciled.assignments[90])
        let diff = try AXTreeDiff.render(
            old: [line(6, "\tg1:6 ruler Ruler")],
            new: [line(stableID, "\tg1:7 ruler Ruler")]
        )
        XCTAssertEqual(diff.removedIDs, [6])
        XCTAssertEqual(diff.markedLines, ["+\tg1:7 ruler Ruler"])
    }

    func testDuplicateFingerprintDisplayNodesRemainUniqueByRawPath() throws {
        let first = StableKey.displayOnly(displayKey(path: [0, 2]))
        let second = StableKey.displayOnly(displayKey(path: [0, 3]))
        let reconciled = try AXTreeDiff.reconcile(
            previous: [
                AXTreeIdentity(id: 6, key: first),
                AXTreeIdentity(id: 7, key: second),
            ],
            current: [
                AXTreeIdentity(id: 90, key: first),
                AXTreeIdentity(id: 91, key: second),
            ],
            nextID: 8
        )

        XCTAssertEqual(reconciled.assignments, [90: 6, 91: 7])
    }

    func testDuplicateSyntheticDisplayOnlyKeysNeverInheritOldIDs() throws {
        let key = StableKey.displayOnly(displayKey(
            path: [0, 2],
            role: "AXStaticText",
            title: "Repeated",
            fingerprint: "AXRow:row-1"
        ))
        let reconciled = try AXTreeDiff.reconcile(
            previous: [
                AXTreeIdentity(id: 6, key: key),
                AXTreeIdentity(id: 7, key: key),
            ],
            current: [
                AXTreeIdentity(id: 90, key: key),
                AXTreeIdentity(id: 91, key: key),
            ],
            nextID: 8
        )

        XCTAssertEqual(reconciled.assignments, [90: 8, 91: 9])
    }

    func testDisplayOnlyIDMayBeMembershipVisibleButNeverActionRefetchable() {
        let key = StableKey.displayOnly(displayKey(path: [0, 2]))
        let transientKey = StableKey.transientDisplay(displayKey(path: [0, 3]))
        let membership = AXTreeHandleMembership(
            snapshotID: 7,
            processIdentity: processA,
            elementIDs: [6]
        )

        XCTAssertTrue(membership.contains(
            SnapshotElementHandle(snapshotID: 7, index: 6),
            currentProcessIdentity: processA
        ))
        XCTAssertFalse(key.isActionRefetchable)
        XCTAssertFalse(transientKey.isActionRefetchable)
        XCTAssertTrue(StableKey.actionable("locator").isActionRefetchable)
    }

    func testRefreshPolicyReusesOnlyTheSameProvenKeyWindow() {
        XCTAssertEqual(
            AXTreeDiff.refreshPolicy(
                previousProcessIdentity: processA,
                currentProcessIdentity: processA,
                previousWindowID: 42,
                currentWindowID: 42,
                hasBaseline: true,
                disableDiff: false
            ),
            AXTreeRefreshPolicy(reuseEpoch: true, returnFull: false)
        )
        XCTAssertEqual(
            AXTreeDiff.refreshPolicy(
                previousProcessIdentity: processA,
                currentProcessIdentity: processA,
                previousWindowID: 42,
                currentWindowID: 99,
                hasBaseline: true,
                disableDiff: false
            ),
            AXTreeRefreshPolicy(reuseEpoch: false, returnFull: true)
        )
        XCTAssertEqual(
            AXTreeDiff.refreshPolicy(
                previousProcessIdentity: processA,
                currentProcessIdentity: processA,
                previousWindowID: 42,
                currentWindowID: nil,
                hasBaseline: true,
                disableDiff: false
            ),
            AXTreeRefreshPolicy(reuseEpoch: false, returnFull: true)
        )
    }

    func testDisableDiffAndMissingBaselineForceFullWithoutRotatingProvenEpoch() {
        XCTAssertEqual(
            AXTreeDiff.refreshPolicy(
                previousProcessIdentity: processA,
                currentProcessIdentity: processA,
                previousWindowID: 42,
                currentWindowID: 42,
                hasBaseline: true,
                disableDiff: true
            ),
            AXTreeRefreshPolicy(reuseEpoch: true, returnFull: true)
        )
        XCTAssertEqual(
            AXTreeDiff.refreshPolicy(
                previousProcessIdentity: nil,
                currentProcessIdentity: processA,
                previousWindowID: nil,
                currentWindowID: 42,
                hasBaseline: false,
                disableDiff: false
            ),
            AXTreeRefreshPolicy(reuseEpoch: false, returnFull: true)
        )
    }

    func testRelaunchedProcessWithReusedPIDAndWindowIDRotatesEpoch() {
        let relaunched = AXTreeProcessIdentity(
            bundleID: processA.bundleID,
            executablePath: processA.executablePath,
            launchTime: 200
        )

        XCTAssertEqual(
            AXTreeDiff.refreshPolicy(
                previousProcessIdentity: processA,
                currentProcessIdentity: relaunched,
                previousWindowID: 42,
                currentWindowID: 42,
                hasBaseline: true,
                disableDiff: false
            ),
            AXTreeRefreshPolicy(reuseEpoch: false, returnFull: true)
        )
    }
}
