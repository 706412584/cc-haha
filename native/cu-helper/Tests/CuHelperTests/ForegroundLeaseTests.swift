import Darwin
import XCTest
@testable import cc_haha_computer_use

@MainActor
final class ForegroundLeaseTests: XCTestCase {
    private let identityA = AXTreeProcessIdentity(
        bundleID: "com.example.a",
        executablePath: "/Applications/A.app/Contents/MacOS/A",
        launchTime: 100
    )
    private let identityB = AXTreeProcessIdentity(
        bundleID: "com.example.b",
        executablePath: "/Applications/B.app/Contents/MacOS/B",
        launchTime: 200
    )
    private let identityC = AXTreeProcessIdentity(
        bundleID: "com.example.c",
        executablePath: "/Applications/C.app/Contents/MacOS/C",
        launchTime: 300
    )

    func testTargetStoleFocusRestoresWithoutPhysicalInput() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: original, target: target),
                finalEvidence: evidence(epoch: 9, frontmost: target),
                currentOriginalIdentity: identityA
            ),
            .restore(11)
        )
    }

    func testPhysicalInputPreventsRestoration() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: original, target: target),
                finalEvidence: evidence(
                    epochBefore: 10,
                    epochAfter: 10,
                    frontmost: target
                ),
                currentOriginalIdentity: identityA
            ),
            .userInterference
        )
    }

    func testUnstableFinalizeEpochPairNeverRestores() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: original, target: target),
                finalEvidence: evidence(
                    epochBefore: 9,
                    epochAfter: 10,
                    frontmost: target
                ),
                currentOriginalIdentity: identityA
            ),
            .userInterference
        )
    }

    func testMissingMonitorFailsOnlyWhenTargetTookForeground() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        let lease = snapshot(
            original: original,
            target: target,
            monitorAvailable: false
        )

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: lease,
                finalEvidence: evidence(epoch: 9, frontmost: original),
                currentOriginalIdentity: identityA
            ),
            .unchanged
        )
        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: lease,
                finalEvidence: evidence(epoch: 9, frontmost: target),
                currentOriginalIdentity: identityA
            ),
            .isolationUnavailable
        )
    }

    func testMonitorContinuityChangeNeverRestoresTarget() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: original, target: target),
                finalEvidence: evidence(
                    epochBefore: 9,
                    epochAfter: 9,
                    frontmost: target,
                    generationBefore: 2,
                    generationAfter: 2
                ),
                currentOriginalIdentity: identityA
            ),
            .isolationUnavailable
        )
    }

    func testThirdAppNilAndReusedTargetAreUserInterference() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        let third = try self.target(pid: 33, identity: identityC)
        let reusedTarget = try self.target(pid: 22, identity: identityC)
        let lease = snapshot(original: original, target: target)

        for current in [third, reusedTarget, nil] as [ProvenProcessTarget?] {
            XCTAssertEqual(
                try ForegroundLeasePolicy.decision(
                    lease: lease,
                    finalEvidence: evidence(epoch: 9, frontmost: current),
                    currentOriginalIdentity: identityA
                ),
                .userInterference
            )
        }
    }

    func testAlreadyFrontmostTargetNeverRestores() throws {
        let target = try self.target(pid: 22, identity: identityB)

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: target, target: target),
                finalEvidence: evidence(epoch: 9, frontmost: target),
                currentOriginalIdentity: identityB
            ),
            .unchanged
        )

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: target, target: target),
                finalEvidence: evidence(epoch: 10, frontmost: target),
                currentOriginalIdentity: identityB
            ),
            .userInterferenceResultUnknown
        )

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: target, target: target),
                finalEvidence: evidence(
                    epoch: 9,
                    frontmost: target,
                    available: false
                ),
                currentOriginalIdentity: identityB
            ),
            .isolationUnavailable
        )
    }

    func testAlreadyFrontmostPhysicalInputMakesMutationResultUnknown() async throws {
        let target = try self.target(pid: 22, identity: identityB)
        var snapshots = [
            input(epoch: 9), input(epoch: 9),
            input(epoch: 10), input(epoch: 10),
        ]
        var foregrounds = [target, target]
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { _ in self.identityB },
            activate: { _ in XCTFail("must not activate"); return false },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        await assertCUError("user_interference_result_unknown") {
            let _: Int = try await ForegroundMutationRunner.run(lease: lease) { 42 }
        }
    }

    func testOriginalUnchangedSucceedsDespitePhysicalInputAndMonitorLoss() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: original, target: target),
                finalEvidence: evidence(
                    epochBefore: 10,
                    epochAfter: 11,
                    frontmost: original,
                    available: false,
                    generationBefore: 2,
                    generationAfter: 3
                ),
                currentOriginalIdentity: identityA
            ),
            .unchanged
        )
    }

    func testMissingOriginalPIDCannotRestore() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)

        XCTAssertThrowsError(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: original, target: target),
                finalEvidence: evidence(epoch: 9, frontmost: target),
                currentOriginalIdentity: nil
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "focus_restore_failed")
        }
    }

    func testReusedOriginalPIDCannotRestoreReplacementProcess() throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)

        XCTAssertThrowsError(
            try ForegroundLeasePolicy.decision(
                lease: snapshot(original: original, target: target),
                finalEvidence: evidence(epoch: 9, frontmost: target),
                currentOriginalIdentity: identityC
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "focus_restore_failed")
        }
    }

    func testNilOriginalContract() throws {
        let target = try self.target(pid: 22, identity: identityB)
        let third = try self.target(pid: 33, identity: identityC)
        let lease = snapshot(original: nil, target: target)

        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: lease,
                finalEvidence: evidence(epoch: 9, frontmost: nil),
                currentOriginalIdentity: nil
            ),
            .unchanged
        )
        XCTAssertEqual(
            try ForegroundLeasePolicy.decision(
                lease: lease,
                finalEvidence: evidence(epoch: 9, frontmost: third),
                currentOriginalIdentity: nil
            ),
            .userInterference
        )
        XCTAssertThrowsError(
            try ForegroundLeasePolicy.decision(
                lease: lease,
                finalEvidence: evidence(epoch: 9, frontmost: target),
                currentOriginalIdentity: nil
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "focus_restore_failed")
        }
    }

    func testHeldInputReleaseRequiresOriginalProcessLifetime() throws {
        let held = try target(pid: 11, identity: identityA)

        XCTAssertEqual(
            HeldInputReleasePolicy.pid(for: held, currentIdentity: identityA),
            11
        )
        XCTAssertNil(
            HeldInputReleasePolicy.pid(for: held, currentIdentity: identityC)
        )
        XCTAssertNil(
            HeldInputReleasePolicy.pid(for: held, currentIdentity: nil)
        )
    }

    func testFailedHeldReleaseRetainsTeardownRecordUntilSuccessfulPost() {
        var ledger = HeldReleaseLedger<String>()
        ledger.append("left@process-a")

        // Simulated validation/allocation/post failure: complete is not called.
        XCTAssertEqual(ledger.records, ["left@process-a"])

        // Only the successful-post path consumes the record.
        ledger.complete("left@process-a")
        XCTAssertTrue(ledger.records.isEmpty)
    }

    func testTeardownPlanRetainsRetryableFailuresAndDiscardsInvalidIdentity() {
        XCTAssertEqual(
            HeldInputReleasePolicy.teardownPlan(
                identityMatches: true,
                sourceAvailable: false,
                eventAllocated: false
            ),
            .retainForRetry
        )
        XCTAssertEqual(
            HeldInputReleasePolicy.teardownPlan(
                identityMatches: true,
                sourceAvailable: true,
                eventAllocated: false
            ),
            .retainForRetry
        )
        XCTAssertEqual(
            HeldInputReleasePolicy.teardownPlan(
                identityMatches: false,
                sourceAvailable: false,
                eventAllocated: false
            ),
            .discardInvalidTarget
        )
        XCTAssertEqual(
            HeldInputReleasePolicy.teardownPlan(
                identityMatches: true,
                sourceAvailable: true,
                eventAllocated: true
            ),
            .postAndComplete
        )
    }

    func testAcquireRejectsUnstableEpochPairBeforeAction() throws {
        let target = try self.target(pid: 22, identity: identityB)
        var snapshots = [input(epoch: 9), input(epoch: 10)]
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { nil },
            currentIdentity: { _ in self.identityB },
            activate: { _ in XCTFail("must not activate"); return false },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )

        XCTAssertThrowsError(
            try ForegroundLease.acquire(target: target, runtime: runtime)
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "user_interference")
        }
    }

    func testAcquireRejectsUnavailableMonitorBeforeAction() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        var snapshots = [
            input(epoch: 9, available: false),
            input(epoch: 9, available: false),
            input(epoch: 9, available: false),
            input(epoch: 9, available: false),
        ]
        var foregrounds = [original, original]
        var actionCount = 0
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 22 ? self.identityB : self.identityA },
            activate: { _ in XCTFail("must not activate"); return false },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )

        await assertCUError("focus_isolation_unavailable") {
            let lease = try ForegroundLease.acquire(target: target, runtime: runtime)
            let _: Int = try await ForegroundMutationRunner.run(lease: lease) {
                actionCount += 1
                return 42
            }
        }
        XCTAssertEqual(actionCount, 0)
    }

    func testAcquireRejectsMonitorContinuityGapBeforeAction() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        var snapshots = [
            input(epoch: 9, generation: 1),
            input(epoch: 9, generation: 2),
            input(epoch: 9, generation: 2),
            input(epoch: 9, generation: 2),
        ]
        var foregrounds = [original, original]
        var actionCount = 0
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 22 ? self.identityB : self.identityA },
            activate: { _ in XCTFail("must not activate"); return false },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )

        await assertCUError("focus_isolation_unavailable") {
            let lease = try ForegroundLease.acquire(target: target, runtime: runtime)
            let _: Int = try await ForegroundMutationRunner.run(lease: lease) {
                actionCount += 1
                return 42
            }
        }
        XCTAssertEqual(actionCount, 0)
    }

    func testNilOriginalCanAcquireAndRemainNil() async throws {
        let target = try self.target(pid: 22, identity: identityB)
        var snapshots = [input(epoch: 9), input(epoch: 9), input(epoch: 9), input(epoch: 9)]
        var foregrounds: [ProvenProcessTarget?] = [nil, nil]
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { _ in self.identityB },
            activate: { _ in XCTFail("must not activate"); return false },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        try await lease.finalize()
    }

    func testFinalizeIsExactlyOnceAndActivationIsNeverRetried() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        var snapshots = [
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
        ]
        var foregrounds = [original, target, target]
        var activationCount = 0
        var verificationCount = 0
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 11 ? self.identityA : self.identityB },
            activate: { expected in
                XCTAssertEqual(expected, original)
                activationCount += 1
                return false
            },
            verifyFrontmost: { _ in verificationCount += 1; return false }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        await assertCUError("focus_restore_failed") {
            try await lease.finalize()
        }
        await assertCUError("foreground_lease_finalized") {
            try await lease.finalize()
        }
        XCTAssertEqual(activationCount, 1)
        XCTAssertEqual(verificationCount, 0)
    }

    func testSuccessfulActivationHasOneBoundedVerificationAndNoRetry() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        var snapshots = [
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
        ]
        var foregrounds = [original, target, target]
        var activationCount = 0
        var verificationCount = 0
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 11 ? self.identityA : self.identityB },
            activate: { expected in
                XCTAssertEqual(expected, original)
                activationCount += 1
                return true
            },
            verifyFrontmost: { expected in
                XCTAssertEqual(expected, original)
                verificationCount += 1
                return true
            }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        try await lease.finalize()

        XCTAssertEqual(activationCount, 1)
        XCTAssertEqual(verificationCount, 1)
    }

    func testActivationVerificationFailureIsTypedAndNotRetried() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        var snapshots = [
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
        ]
        var foregrounds = [original, target, target]
        var activationCount = 0
        var verificationCount = 0
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 11 ? self.identityA : self.identityB },
            activate: { _ in activationCount += 1; return true },
            verifyFrontmost: { _ in verificationCount += 1; return false }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        await assertCUError("focus_restore_failed") {
            try await lease.finalize()
        }

        XCTAssertEqual(activationCount, 1)
        XCTAssertEqual(verificationCount, 1)
    }

    func testThirdAppAppearingBeforeActivationPreventsRestore() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        let third = try self.target(pid: 33, identity: identityC)
        var snapshots = [
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
        ]
        var foregrounds = [original, target, third]
        var activationCount = 0
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 11 ? self.identityA : self.identityB },
            activate: { _ in activationCount += 1; return true },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        await assertCUError("user_interference") {
            try await lease.finalize()
        }
        XCTAssertEqual(activationCount, 0)
    }

    func testPhysicalInputArrivingBeforeActivationPreventsRestore() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        var snapshots = [
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
            input(epoch: 10), input(epoch: 10),
        ]
        var foregrounds = [original, target, target]
        var activationCount = 0
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 11 ? self.identityA : self.identityB },
            activate: { _ in activationCount += 1; return true },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        await assertCUError("user_interference") {
            try await lease.finalize()
        }
        XCTAssertEqual(activationCount, 0)
    }

    func testContinuityGapBeforeActivationPreventsRestore() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        var snapshots = [
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9), input(epoch: 9),
            input(epoch: 9, generation: 2),
            input(epoch: 9, generation: 2),
        ]
        var foregrounds = [original, target, target]
        var activationCount = 0
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 11 ? self.identityA : self.identityB },
            activate: { _ in activationCount += 1; return true },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        await assertCUError("focus_isolation_unavailable") {
            try await lease.finalize()
        }
        XCTAssertEqual(activationCount, 0)
    }

    func testMutationRunnerFinalizesOnceOnActionSuccess() async throws {
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        let (lease, _) = runtimeLease(original: original, final: original, target: target)

        let result = try await ForegroundMutationRunner.run(lease: lease) { 42 }

        XCTAssertEqual(result, 42)
        await assertCUError("foreground_lease_finalized") {
            try await lease.finalize()
        }
    }

    func testMutationRunnerFinalizesOnceAndPropagatesActionErrorWhenSafe() async throws {
        struct ActionFailure: Error {}
        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        let (lease, _) = runtimeLease(original: original, final: original, target: target)

        do {
            let _: Int = try await ForegroundMutationRunner.run(lease: lease) {
                throw ActionFailure()
            }
            XCTFail("expected action error")
        } catch is ActionFailure {
            // Expected: unchanged finalization must not swallow the action.
        }
        await assertCUError("foreground_lease_finalized") {
            try await lease.finalize()
        }
    }

    func testFinalizeSafetyFailureIsAuthoritativeAndRetainsActionContext() async throws {
        struct ActionFailure: Error, LocalizedError {
            var errorDescription: String? { "action exploded" }
        }

        let original = try target(pid: 11, identity: identityA)
        let target = try target(pid: 22, identity: identityB)
        var snapshots = [input(epoch: 9), input(epoch: 9), input(epoch: 10), input(epoch: 10)]
        var foregrounds = [original, target]
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in pid == 11 ? self.identityA : self.identityB },
            activate: { _ in XCTFail("must not activate after input"); return false },
            verifyFrontmost: { _ in XCTFail("must not verify after input"); return false }
        )
        let lease = try ForegroundLease.acquire(target: target, runtime: runtime)

        do {
            let _: Int = try await ForegroundMutationRunner.run(lease: lease) {
                throw ActionFailure()
            }
            XCTFail("expected safety error")
        } catch let error as CUError {
            XCTAssertEqual(error.code, "user_interference")
            XCTAssertTrue(error.message.contains("action exploded"))
        }
    }

    private func target(
        pid: pid_t,
        identity: AXTreeProcessIdentity
    ) throws -> ProvenProcessTarget {
        try XCTUnwrap(ProvenProcessTarget(pid: pid, identity: identity))
    }

    private func snapshot(
        original: ProvenProcessTarget?,
        target: ProvenProcessTarget,
        monitorAvailable: Bool = true
    ) -> ForegroundLeaseSnapshot {
        ForegroundLeaseSnapshot(
            original: original,
            target: target,
            acquiredEpoch: 9,
            acquiredContinuityGeneration: 1,
            monitorAvailable: monitorAvailable
        )
    }

    private func input(
        epoch: UInt64,
        available: Bool = true,
        generation: UInt64 = 1
    ) -> PhysicalInputEpochSnapshot {
        PhysicalInputEpochSnapshot(
            epoch: epoch,
            available: available,
            continuityGeneration: generation
        )
    }

    private func evidence(
        epoch: UInt64,
        frontmost: ProvenProcessTarget?,
        available: Bool = true,
        generation: UInt64 = 1
    ) -> ForegroundEvidence {
        evidence(
            epochBefore: epoch,
            epochAfter: epoch,
            frontmost: frontmost,
            available: available,
            generationBefore: generation,
            generationAfter: generation
        )
    }

    private func evidence(
        epochBefore: UInt64,
        epochAfter: UInt64,
        frontmost: ProvenProcessTarget?,
        available: Bool = true,
        generationBefore: UInt64 = 1,
        generationAfter: UInt64 = 1
    ) -> ForegroundEvidence {
        ForegroundEvidence(
            epochBefore: epochBefore,
            frontmost: frontmost,
            epochAfter: epochAfter,
            monitorAvailableBefore: available,
            monitorAvailableAfter: available,
            continuityGenerationBefore: generationBefore,
            continuityGenerationAfter: generationAfter
        )
    }

    private func runtimeLease(
        original: ProvenProcessTarget,
        final: ProvenProcessTarget,
        target: ProvenProcessTarget
    ) -> (ForegroundLease, ForegroundLeaseRuntime) {
        var snapshots = [input(epoch: 9), input(epoch: 9), input(epoch: 9), input(epoch: 9)]
        var foregrounds = [original, final]
        let runtime = ForegroundLeaseRuntime(
            inputSnapshot: { snapshots.removeFirst() },
            frontmostTarget: { foregrounds.removeFirst() },
            currentIdentity: { pid in
                if pid == original.pid { return original.identity }
                if pid == target.pid { return target.identity }
                return nil
            },
            activate: { _ in XCTFail("must not activate"); return false },
            verifyFrontmost: { _ in XCTFail("must not verify"); return false }
        )
        return (try! ForegroundLease.acquire(target: target, runtime: runtime), runtime)
    }

    private func assertCUError(
        _ expectedCode: String,
        operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("expected CUError \(expectedCode)")
        } catch let error as CUError {
            XCTAssertEqual(error.code, expectedCode)
        } catch {
            XCTFail("expected CUError \(expectedCode), got \(error)")
        }
    }
}
