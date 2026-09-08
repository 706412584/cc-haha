import Darwin
import Foundation

/// Authoritative native policy applied only after a resolver has produced a
/// real running process and its current process-lifetime identity. Selector
/// form is deliberately absent, so PID/name/bundle/frontmost/launch paths have
/// no policy bypass.
enum ResolvedTargetAuthorization {
    static func authorize(
        resolved: ResolvedAppTarget,
        currentIdentity: AXTreeProcessIdentity?
    ) throws -> ProvenProcessTarget {
        try authorize(
            pid: resolved.pid,
            identity: currentIdentity,
            expectedBundleID: resolved.bundleIdentifier
        )
    }

    static func authorize(
        pid: pid_t,
        identity: AXTreeProcessIdentity?,
        expectedBundleID: String?
    ) throws -> ProvenProcessTarget {
        guard pid > 0,
              let identity,
              identity.isProven,
              let actualBundleID = identity.bundleID,
              !actualBundleID.isEmpty else {
            throw CUError(
                "app_denied",
                "Computer Use cannot prove the resolved application's bundle identity, so the action was denied."
            )
        }

        if let expectedBundleID {
            guard !expectedBundleID.isEmpty,
                  actualBundleID == expectedBundleID else {
                throw CUError(
                    "stale_process",
                    "The resolved application changed process identity before native policy validation."
                )
            }
        }

        guard AppTargetPolicy.decision(bundleID: actualBundleID) == .allow else {
            throw CUError(
                "app_denied",
                "Computer Use is not allowed to use the app '\(actualBundleID)' for safety reasons."
            )
        }

        guard let target = ProvenProcessTarget(pid: pid, identity: identity) else {
            throw CUError(
                "app_denied",
                "Computer Use cannot prove the resolved application's process lifetime, so the action was denied."
            )
        }
        return target
    }
}
