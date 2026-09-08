import XCTest
@testable import cc_haha_computer_use

final class EventBurstTests: XCTestCase {
    func testAllocationFailurePostsNothing() {
        var allocationCount = 0
        var posted: [Int] = []

        XCTAssertThrowsError(
            try EventBurst.perform(
                specs: [1, 2, 3],
                allocate: { spec in
                    allocationCount += 1
                    return allocationCount == 2 ? nil : spec * 10
                },
                post: { posted.append($0) }
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "event_alloc")
        }
        XCTAssertEqual(allocationCount, 2)
        XCTAssertTrue(posted.isEmpty)
    }

    func testCompleteAllocationPostsWholeBurstInOrder() throws {
        var posted: [Int] = []

        try EventBurst.perform(
            specs: [1, 2, 3],
            allocate: { $0 * 10 },
            post: { posted.append($0) }
        )

        XCTAssertEqual(posted, [10, 20, 30])
    }
}
