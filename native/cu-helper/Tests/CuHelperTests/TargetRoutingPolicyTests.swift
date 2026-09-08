import XCTest
@testable import cc_haha_computer_use

final class TargetRoutingPolicyTests: XCTestCase {
    func testExplicitTargetAlwaysWinsOverCoordinateOwner() throws {
        XCTAssertEqual(try TargetRoutingPolicy.pid(explicit: 42, coordinateOwner: 99), 42)
    }

    func testMissingExplicitTargetFailsClosed() {
        XCTAssertThrowsError(try TargetRoutingPolicy.pid(explicit: nil, coordinateOwner: 99)) {
            XCTAssertEqual(($0 as? CUError)?.code, "no_target")
        }
    }
}
