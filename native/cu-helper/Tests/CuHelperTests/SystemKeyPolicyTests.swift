import XCTest
@testable import cc_haha_computer_use

final class SystemKeyPolicyTests: XCTestCase {
    func testDangerousAliasesAndMultiChordSequencesRequireGrant() throws {
        let dangerous = [
            "cmd+q",
            "cmd + q",
            "command+tab",
            "meta+space",
            "super+spacebar",
            "cmd+shift+tab",
            "shift+super+q",
            "cmd+alt+escape",
            "cmd+option+esc",
            "cmd+opt+esc",
            "ctrl+cmd+q",
            "super+a cmd+q ctrl+v",
            "fn+cmd+q",
            "fn+cmd+tab",
            "fn+cmd+spacebar",
            "fn+cmd+opt+esc",
        ]

        for sequence in dangerous {
            XCTAssertTrue(
                try SystemKeyPolicy.requiresGrant(sequence),
                "expected dangerous: \(sequence)"
            )
        }
    }

    func testOrdinaryShortcutDoesNotRequireGrant() throws {
        XCTAssertFalse(try SystemKeyPolicy.requiresGrant("super+a"))
        XCTAssertFalse(try SystemKeyPolicy.requiresGrant("ctrl+c ctrl+v"))
        XCTAssertFalse(try SystemKeyPolicy.requiresGrant("cmd+alt+q"))
        XCTAssertFalse(try SystemKeyPolicy.requiresGrant("cmd+shift+a"))
    }

    func testDangerousShortcutFailsClosedWithoutGrant() {
        XCTAssertThrowsError(
            try SystemKeyPolicy.enforce(sequence: "cmd+opt+esc", granted: false)
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "grant_flag_required")
        }
    }

    func testDangerousShortcutPassesWithGrant() throws {
        try SystemKeyPolicy.enforce(sequence: "cmd+opt+esc", granted: true)
    }

    func testPayloadGrantDefaultsFalseAndRequiresBoolean() throws {
        XCTAssertFalse(try SystemKeyPolicy.parseGrant(nil))
        XCTAssertFalse(try SystemKeyPolicy.parseGrant(.bool(false)))
        XCTAssertTrue(try SystemKeyPolicy.parseGrant(.bool(true)))

        for invalid in [JSONValue.string("true"), .int(1), .null] {
            XCTAssertThrowsError(try SystemKeyPolicy.parseGrant(invalid)) {
                XCTAssertEqual(($0 as? CUError)?.code, "bad_payload")
            }
        }
    }
}
