import XCTest
@testable import cc_haha_computer_use

final class ResolvedTargetAuthorizationTests: XCTestCase {
    private let terminalIdentity = AXTreeProcessIdentity(
        bundleID: "com.apple.Terminal",
        executablePath: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
        launchTime: 100
    )
    private let calculatorIdentity = AXTreeProcessIdentity(
        bundleID: "com.apple.calculator",
        executablePath: "/System/Applications/Calculator.app/Contents/MacOS/Calculator",
        launchTime: 200
    )

    func testNumericPIDCannotBypassDeniedResolvedBundle() {
        XCTAssertThrowsError(
            try ResolvedTargetAuthorization.authorize(
                pid: 41,
                identity: terminalIdentity,
                expectedBundleID: nil
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "app_denied")
        }
    }

    func testPIDBundleAndLocalizedNameSelectorsAllAuthorizeActualResolvedBundle() throws {
        let terminal = AppTargetCandidate(
            pid: 41,
            bundleIdentifier: "com.apple.Terminal",
            bundleURL: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"),
            localizedName: "终端",
            executableName: "Terminal"
        )
        let selectors: [AppTargetSelector] = [
            .pid(41),
            .bundleIdentifier("com.apple.Terminal"),
            .app("终端"),
        ]

        for selector in selectors {
            let resolved = try XCTUnwrap(
                AppTargetResolver.resolve(selector: selector, candidates: [terminal])
            )
            XCTAssertThrowsError(
                try ResolvedTargetAuthorization.authorize(
                    resolved: resolved,
                    currentIdentity: terminalIdentity
                )
            ) {
                XCTAssertEqual(($0 as? CUError)?.code, "app_denied")
            }
        }
    }

    func testWorktreePathResolutionStillReachesIntrinsicSelfControlDenial() throws {
        let installed = AppTargetCandidate(
            pid: 100,
            bundleIdentifier: "com.claude-code-haha.desktop",
            bundleURL: URL(fileURLWithPath: "/Applications/Claude Code Haha.app"),
            localizedName: "Claude Code Haha",
            executableName: "Claude Code Haha"
        )
        let worktree = AppTargetCandidate(
            pid: 200,
            bundleIdentifier: installed.bundleIdentifier,
            bundleURL: URL(fileURLWithPath: "/Users/test/worktree/desktop/build-artifacts/macos-arm64/Claude Code Haha.app"),
            localizedName: installed.localizedName,
            executableName: installed.executableName
        )
        let resolved = try AppTargetResolver.match(
            identifier: worktree.bundleURL!.path,
            candidates: [installed, worktree]
        )
        let identity = AXTreeProcessIdentity(
            bundleID: worktree.bundleIdentifier,
            executablePath: worktree.bundleURL!.appendingPathComponent("Contents/MacOS/Claude Code Haha").path,
            launchTime: 300
        )

        XCTAssertEqual(resolved.pid, worktree.pid)
        XCTAssertThrowsError(
            try ResolvedTargetAuthorization.authorize(
                resolved: resolved,
                currentIdentity: identity
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "app_denied")
            XCTAssertEqual(
                ($0 as? CUError)?.message,
                "Computer Use is not allowed to use the app 'com.claude-code-haha.desktop' for safety reasons."
            )
        }
    }

    func testOmittedFrontmostAndLaunchedTargetsUseSameActualBundlePolicy() {
        // Both paths ultimately produce this same resolved target shape. The
        // authorizer intentionally has no selector-specific bypass.
        let resolved = ResolvedAppTarget(
            pid: 41,
            bundleIdentifier: "com.apple.Terminal",
            bundleURL: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        )

        for _ in ["omitted-frontmost", "launched-get-app-state"] {
            XCTAssertThrowsError(
                try ResolvedTargetAuthorization.authorize(
                    resolved: resolved,
                    currentIdentity: terminalIdentity
                )
            ) {
                XCTAssertEqual(($0 as? CUError)?.code, "app_denied")
            }
        }
    }

    func testAllowedResolvedTargetReturnsExactProvenProcessLifetime() throws {
        let target = try ResolvedTargetAuthorization.authorize(
            pid: 42,
            identity: calculatorIdentity,
            expectedBundleID: "com.apple.calculator"
        )

        XCTAssertEqual(target.pid, 42)
        XCTAssertEqual(target.identity, calculatorIdentity)
    }

    func testMissingBundleAndResolverIdentityMismatchFailClosed() {
        let missingBundle = AXTreeProcessIdentity(
            bundleID: nil,
            executablePath: "/Applications/Unknown.app/Contents/MacOS/Unknown",
            launchTime: 100
        )

        XCTAssertThrowsError(
            try ResolvedTargetAuthorization.authorize(
                pid: 42,
                identity: missingBundle,
                expectedBundleID: nil
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "app_denied")
        }

        XCTAssertThrowsError(
            try ResolvedTargetAuthorization.authorize(
                pid: 42,
                identity: calculatorIdentity,
                expectedBundleID: "com.example.reused"
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "stale_process")
        }
    }
}
