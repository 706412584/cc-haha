import XCTest

@testable import cc_haha_computer_use

/// Guards the per-app guidance against two failures that cost several real
/// sessions.
@MainActor
final class AppGuidanceConsistencyTests: XCTestCase {
    /// NetEase Music is the app this whole shell-tree path was debugged
    /// against, and it was classified `.native` — which reports frame
    /// reliability "high" (wrong: it draws its own surfaces) and hands the
    /// model no app guidance at all. Its sibling Chinese CEF music clients have
    /// the same shape.
    func testChineseCEFClientsAreRecognised() {
        for bundleId in [
            "com.netease.163music",
            "com.netease.cloudmusic",
            "com.kugou.mac",
            "cn.kuwo.mac",
            "com.tencent.qqmusicmac",
        ] {
            XCTAssertEqual(
                AppGuidance.classify(bundleId: bundleId),
                .electron,
                "\(bundleId) draws its own surfaces; classifying it native lies about frame reliability"
            )
        }
    }

    /// The known Electron set must not regress while adding the new markers.
    func testEstablishedElectronAppsStillClassify() {
        for bundleId in [
            "com.microsoft.vscode",
            "com.tinyspeck.slackmacgap",
            "md.obsidian",
            "com.figma.desktop",
        ] {
            XCTAssertEqual(AppGuidance.classify(bundleId: bundleId), .electron)
        }
    }

    /// Ordinary AppKit apps must stay native, or every app would be told to
    /// abandon element handles.
    func testNativeAppsAreNotMisclassified() {
        for bundleId in ["com.apple.TextEdit", "com.apple.finder", "com.apple.Notes"] {
            XCTAssertNotEqual(AppGuidance.classify(bundleId: bundleId), .electron)
        }
    }

    /// The Electron guidance used to say "never by coordinate" while the
    /// shell-tree advice said "coordinates are the ONLY way". Any Electron app
    /// with a dead tree received both at once, and the model had no way to
    /// resolve it. Neither text may state an unconditional rule again.
    func testGuidanceDoesNotContradictTheShellTreeAdvice() {
        // Reach the electron text through a real app rather than the enum, so
        // the test also proves that app actually receives it.
        guard let electron = AppGuidance.instructions(bundleId: "com.netease.163music") else {
            return XCTFail("a CEF app must receive guidance; nil means it fell through to native")
        }

        XCTAssertFalse(
            electron.contains("never by coordinate"),
            "an unconditional ban contradicts the shell-tree advice, which says coordinates are the only route"
        )
        // It must still express the preference, just conditionally.
        XCTAssertTrue(electron.lowercased().contains("prefer element index"))
        XCTAssertTrue(
            electron.contains("x and y"),
            "must name the escape hatch for a dead tree"
        )

        // And the two texts must agree on when to switch.
        XCTAssertTrue(electron.contains("menu bar"))
        XCTAssertTrue(ShellTreeAdvice.advice.contains("menu bar"))
    }
}
