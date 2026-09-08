import AppKit
import XCTest
@testable import cc_haha_computer_use

final class TextEditingTests: XCTestCase {
    func testSelectRangeUsesUTF16AndContext() throws {
        let range = try TextEditing.range(
            in: "🙂 quick brown fox",
            text: "brown",
            prefix: "quick ",
            suffix: " fox"
        )

        XCTAssertEqual(range.location, 9)
        XCTAssertEqual(range.length, 5)
    }

    func testCaretAfterCollapsesAtEnd() throws {
        let selected = NSRange(location: 6, length: 5)

        XCTAssertEqual(
            TextEditing.selectionRange(selected, mode: .cursorAfter),
            NSRange(location: 11, length: 0)
        )
    }

    func testTextAndCaretBeforeSelectionModes() {
        let selected = NSRange(location: 6, length: 5)

        XCTAssertEqual(
            TextEditing.selectionRange(selected, mode: .text),
            selected
        )
        XCTAssertEqual(
            TextEditing.selectionRange(selected, mode: .cursorBefore),
            NSRange(location: 6, length: 0)
        )
    }

    func testInsertionReplacesSelection() throws {
        let edit = try TextEditing.replacingSelection(
            in: "hello world",
            range: NSRange(location: 6, length: 5),
            with: "Codex"
        )

        XCTAssertEqual(edit.value, "hello Codex")
        XCTAssertEqual(edit.caret, NSRange(location: 11, length: 0))
    }

    func testRepeatedTextWithoutContextFailsClosedAsAmbiguous() {
        XCTAssertThrowsError(
            try TextEditing.range(in: "one target two target", text: "target")
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "ambiguous_text")
        }
    }

    func testOverlappingRepeatedTextFailsClosedAsAmbiguous() {
        XCTAssertThrowsError(
            try TextEditing.range(in: "aaa", text: "aa")
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "ambiguous_text")
        }
    }

    func testPrefixDisambiguatesRepeatedText() throws {
        let range = try TextEditing.range(
            in: "first target then second target",
            text: "target",
            prefix: "second "
        )

        XCTAssertEqual(range, NSRange(location: 25, length: 6))
    }

    func testSuffixDisambiguatesRepeatedText() throws {
        let range = try TextEditing.range(
            in: "target alpha then target omega",
            text: "target",
            suffix: " omega"
        )

        XCTAssertEqual(range, NSRange(location: 18, length: 6))
    }

    func testReplacingSelectionRejectsOutOfBoundsUTF16Range() {
        XCTAssertThrowsError(
            try TextEditing.replacingSelection(
                in: "🙂 ok",
                range: NSRange(location: 2, length: 99),
                with: "nope"
            )
        ) {
            XCTAssertEqual(($0 as? CUError)?.code, "invalid_selection")
        }
    }

    func testCaretFailureRollsBackBeforeRetrySafeFallback() {
        let edit = TextEditing.Edit(
            value: "hello Codex",
            caret: NSRange(location: 11, length: 0)
        )
        var writtenValues: [String] = []
        var caretWrites: [NSRange] = []

        let outcome = TextEditing.commitOnce(
            edit,
            originalValue: "hello world",
            originalSelection: NSRange(location: 6, length: 5),
            writeValue: {
                writtenValues.append($0)
                return true
            },
            writeCaret: {
                caretWrites.append($0)
                return caretWrites.count > 1
            }
        )

        XCTAssertEqual(outcome, .rolledBack)
        XCTAssertEqual(writtenValues, ["hello Codex", "hello world"])
        XCTAssertEqual(
            caretWrites,
            [
                NSRange(location: 11, length: 0),
                NSRange(location: 6, length: 5),
            ]
        )
    }

    func testFailedValueRollbackTreatsCommittedEditAsSuccess() {
        let edit = TextEditing.Edit(
            value: "hello Codex",
            caret: NSRange(location: 11, length: 0)
        )
        var valueWriteCount = 0

        let outcome = TextEditing.commitOnce(
            edit,
            originalValue: "hello world",
            originalSelection: NSRange(location: 6, length: 5),
            writeValue: { _ in
                valueWriteCount += 1
                return valueWriteCount == 1
            },
            writeCaret: { _ in false }
        )

        XCTAssertEqual(outcome, .valueOnly)
        XCTAssertEqual(valueWriteCount, 2)
    }

    func testRestoredValueWithUnknownSelectionStopsForFreshState() {
        let edit = TextEditing.Edit(
            value: "hello Codex",
            caret: NSRange(location: 11, length: 0)
        )

        let outcome = TextEditing.commitOnce(
            edit,
            originalValue: "hello world",
            originalSelection: NSRange(location: 6, length: 5),
            writeValue: { _ in true },
            writeCaret: { _ in false }
        )

        XCTAssertEqual(outcome, .stateUnknown)
    }

    @MainActor
    func testClipboardLeaseRestoresOriginallyEmptyPasteboard() throws {
        let pasteboard = NSPasteboard.withUniqueName()
        pasteboard.clearContents()
        let lease = ClipboardLease(pasteboard: pasteboard)

        try lease.writeTemporaryString("temporary")
        XCTAssertEqual(pasteboard.string(forType: .string), "temporary")
        XCTAssertTrue(lease.restoreIfUnchanged())

        XCTAssertTrue(pasteboard.pasteboardItems?.isEmpty ?? true)
        XCTAssertNil(pasteboard.string(forType: .string))
    }

    @MainActor
    func testClipboardLeaseRestoresAllItemsAndTypeData() throws {
        let pasteboard = NSPasteboard.withUniqueName()
        let customType = NSPasteboard.PasteboardType("com.cc-haha.test.binary")
        let secondType = NSPasteboard.PasteboardType("com.cc-haha.test.second")
        let binary = Data([0x00, 0x7f, 0xff])
        let secondData = Data([0x01, 0x02])
        let first = NSPasteboardItem()
        first.setString("original", forType: .string)
        first.setData(binary, forType: customType)
        let second = NSPasteboardItem()
        second.setData(secondData, forType: secondType)
        pasteboard.clearContents()
        XCTAssertTrue(pasteboard.writeObjects([first, second]))
        let lease = ClipboardLease(pasteboard: pasteboard)

        try lease.writeTemporaryString("temporary")
        XCTAssertTrue(lease.restoreIfUnchanged())

        let restored = try XCTUnwrap(pasteboard.pasteboardItems)
        XCTAssertEqual(restored.count, 2)
        XCTAssertEqual(restored[0].string(forType: .string), "original")
        XCTAssertEqual(restored[0].data(forType: customType), binary)
        XCTAssertEqual(restored[1].data(forType: secondType), secondData)
    }

    @MainActor
    func testClipboardLeaseNeverOverwritesExternalCopy() throws {
        let pasteboard = NSPasteboard.withUniqueName()
        pasteboard.clearContents()
        pasteboard.setString("original", forType: .string)
        let lease = ClipboardLease(pasteboard: pasteboard)

        try lease.writeTemporaryString("temporary")
        pasteboard.clearContents()
        pasteboard.setString("user copied while paste was in flight", forType: .string)

        XCTAssertFalse(lease.temporaryWriteIsCurrent())
        XCTAssertFalse(lease.restoreIfUnchanged())
        XCTAssertEqual(
            pasteboard.string(forType: .string),
            "user copied while paste was in flight"
        )
    }
}
