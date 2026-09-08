import XCTest
@testable import cc_haha_computer_use

final class AppTargetPolicyTests: XCTestCase {
    func testTerminalAndAutomationBundlesAreDenied() {
        let denied = [
            "com.apple.Terminal",
            "com.googlecode.iterm2",
            "com.microsoft.VSCode",
            "com.apple.shortcuts",
        ]

        for bundleID in denied {
            XCTAssertEqual(AppTargetPolicy.decision(bundleID: bundleID), .deny, bundleID)
        }
    }

    func testBrowserBundlesAreDenied() {
        for bundleID in ["com.google.Chrome", "com.apple.Safari"] {
            XCTAssertEqual(AppTargetPolicy.decision(bundleID: bundleID), .deny, bundleID)
        }
    }

    func testTradingAndWalletBundlesAreDenied() {
        let denied = [
            "com.webull.desktop.v1",
            "com.binance.BinanceDesktop",
            "com.electron.exodus",
            "com.ledger.live",
            "io.trezor.TrezorSuite",
        ]

        for bundleID in denied {
            XCTAssertEqual(AppTargetPolicy.decision(bundleID: bundleID), .deny, bundleID)
        }
    }

    func testStreamingMusicAndPublisherPolicyBundlesAreDenied() {
        let denied = [
            "com.spotify.client",
            "com.apple.Music",
            "com.amazon.aiv.AIVApp",
            "tv.plex.desktop",
            "com.amazon.Kindle",
        ]

        for bundleID in denied {
            XCTAssertEqual(AppTargetPolicy.decision(bundleID: bundleID), .deny, bundleID)
        }
    }

    func testNormalProductivityBundlesAreAllowed() {
        let allowed = [
            "com.apple.calculator",
            "com.apple.TextEdit",
            "com.apple.finder",
        ]

        for bundleID in allowed {
            XCTAssertEqual(AppTargetPolicy.decision(bundleID: bundleID), .allow, bundleID)
        }
    }

    func testIntrinsicHostAndHelperBundlesAreAlwaysDenied() {
        let expected: Set<String> = [
            "com.claude-code-haha.desktop",
            "dev.cchaha.cu-helper",
        ]

        XCTAssertEqual(AppTargetPolicy.intrinsicDeniedBundleIDs, expected)
        for bundleID in expected {
            XCTAssertEqual(AppTargetPolicy.decision(bundleID: bundleID), .deny, bundleID)
        }
    }

    func testDeniedBundleUnionCountAndSetDuplicateHandlingAreLocked() {
        XCTAssertEqual(AppTargetPolicy.deniedBundleIDs.count, 107)
        XCTAssertTrue(
            AppTargetPolicy.deniedBundleIDs
                .isDisjoint(with: AppTargetPolicy.intrinsicDeniedBundleIDs)
        )

        var copy = AppTargetPolicy.deniedBundleIDs
        let duplicate = copy.insert("com.apple.Safari")
        XCTAssertFalse(duplicate.inserted)
        XCTAssertEqual(copy.count, 107)
    }
}
