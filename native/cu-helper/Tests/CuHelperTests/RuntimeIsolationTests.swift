import Darwin
import Foundation
import XCTest

@testable import cc_haha_computer_use

@MainActor
final class RuntimeIsolationTests: XCTestCase {
    func testHeadlessCursorRoundTripsOnlyThroughTheConfiguredSandbox() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("cu-cursor-isolation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let previous = getenv("CLAUDE_CONFIG_DIR").map { String(cString: $0) }
        setenv("CLAUDE_CONFIG_DIR", directory.path, 1)
        defer {
            if let previous { setenv("CLAUDE_CONFIG_DIR", previous, 1) }
            else { unsetenv("CLAUDE_CONFIG_DIR") }
            try? FileManager.default.removeItem(at: directory)
        }

        let cursor = VirtualCursor(headless: true)
        XCTAssertEqual(cursor.position, .zero)
        await cursor.move(to: CGPoint(x: 13, y: 29), animated: false)
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent(".runtime/cu-helper.cursor.json").path
        ))
        XCTAssertEqual(VirtualCursor(headless: true).position, CGPoint(x: 13, y: 29))
    }
}
