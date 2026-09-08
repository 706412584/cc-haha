import AppKit
import Foundation
import os

enum ClipboardPasteFormat: String, Sendable {
    case text
    case md
    case html

    func promisedData(for text: String) -> [NSPasteboard.PasteboardType: Data] {
        switch self {
        case .text, .md:
            return [.string: Data(text.utf8)]
        case .html:
            let html = Data(text.utf8)
            let plain = (
                try? NSAttributedString(
                    data: html,
                    options: [
                        .documentType: NSAttributedString.DocumentType.html,
                        .characterEncoding: String.Encoding.utf8.rawValue,
                    ],
                    documentAttributes: nil
                ).string
            ) ?? text
            return [.html: html, .string: Data(plain.utf8)]
        }
    }
}

/// Confirms that this pasteboard item's promised bytes were requested and
/// supplied. AppKit does not identify the reader: this is not proof that the
/// intended application's focused field accepted the text.
final class ClipboardPasteReceipt: NSObject, NSPasteboardItemDataProvider, @unchecked Sendable {
    struct Diagnostic: Sendable {
        let status: String
        let pastePosted: Bool
        let dataRequested: Bool
        let dataSupplied: Bool
        let providerFinished: Bool
        let readElapsedMilliseconds: Double?
        let elapsedMilliseconds: Double
        let ownedBeforeRestore: Bool
        let restored: Bool
    }

    private struct State {
        var requested = false
        var suppliedAt: ContinuousClock.Instant?
        var finished = false
    }

    @MainActor private(set) static var lastDiagnostic: Diagnostic?
    private let promisedData: [NSPasteboard.PasteboardType: Data]
    private let state = OSAllocatedUnfairLock(initialState: State())

    init(text: String) {
        promisedData = ClipboardPasteFormat.text.promisedData(for: text)
        super.init()
    }

    init(text: String, format: ClipboardPasteFormat) {
        promisedData = format.promisedData(for: text)
        super.init()
    }

    @MainActor
    static func resetForTurn() {
        lastDiagnostic = nil
    }

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        guard let data = promisedData[type] else { return }
        state.withLock { $0.requested = true }
        guard item.setData(data, forType: type) else { return }
        state.withLock { value in
            if value.suppliedAt == nil { value.suppliedAt = .now }
        }
    }

    func pasteboardFinishedWithDataProvider(_ pasteboard: NSPasteboard) {
        // Ownership loss also invokes this callback. It is never a read ack.
        state.withLock { $0.finished = true }
    }

    @MainActor
    static func perform(
        text: String,
        format: ClipboardPasteFormat = .text,
        lease: ClipboardLease,
        timeout: Duration = .seconds(2),
        sendPaste: @MainActor (_ validateBeforePosting: @MainActor () throws -> Void) async throws -> Void
    ) async throws {
        lastDiagnostic = nil
        let started = ContinuousClock.now
        var receipt: ClipboardPasteReceipt?
        var posted = false
        var status = "failed"
        defer {
            let owned = lease.temporaryWriteIsCurrent()
            let observed = receipt?.state.withLock { $0 }
            let restored = lease.restoreIfUnchanged()
            lastDiagnostic = Diagnostic(
                status: status,
                pastePosted: posted,
                dataRequested: observed?.requested ?? false,
                dataSupplied: observed?.suppliedAt != nil,
                providerFinished: observed?.finished ?? false,
                readElapsedMilliseconds: observed?.suppliedAt.map {
                    milliseconds(started.duration(to: $0))
                },
                elapsedMilliseconds: milliseconds(started.duration(to: .now)),
                ownedBeforeRestore: owned,
                restored: restored
            )
        }
        do {
            try Task.checkCancellation()
            let written = try lease.writeTemporaryContentWithReceipt(text, format: format)
            receipt = written
            try await Task.sleep(for: .milliseconds(40))
            let validate: @MainActor () throws -> Void = {
                guard lease.temporaryWriteIsCurrent() else {
                    throw CUError("clipboard_changed", "The clipboard changed before paste; no further paste was sent")
                }
            }
            try validate()
            try await sendPaste(validate)
            posted = true
            try await written.waitForRead(timeout: timeout, ownsClipboard: lease.temporaryWriteIsCurrent)
            guard lease.temporaryWriteIsCurrent() else {
                throw CUError("clipboard_changed", "The clipboard changed after paste data was supplied")
            }
            try Task.checkCancellation()
            status = "completed"
        } catch {
            status = error is CancellationError ? "cancelled" : (error as? CUError)?.code ?? "failed"
            throw error
        }
    }

    /// Once Command-V was sent, cancellation must not restore the previous
    /// clipboard while the target can still be reading this one. A clipboard
    /// observer may request the bytes before the target does, so an unidentified
    /// read cannot shorten the bounded consumption window. The window starts
    /// when sendPaste returns; after it ends, surface cancellation to the caller.
    @MainActor
    func waitForRead(timeout: Duration, ownsClipboard: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while true {
            guard ownsClipboard() else {
                throw CUError("clipboard_changed", "The clipboard changed while waiting for paste consumption")
            }
            let remaining = ContinuousClock.now.duration(to: deadline)
            guard remaining > .zero else {
                try Task.checkCancellation()
                if state.withLock({ $0.suppliedAt != nil }) { return }
                throw CUError("clipboard_read_timeout", "No pasteboard data read was observed within the paste deadline; inspect the target before retrying")
            }
            await Self.pause(for: min(.milliseconds(10), remaining))
        }
    }

    @MainActor
    private static func pause(for duration: Duration) async {
        let seconds = milliseconds(duration) / 1_000
        guard seconds > 0 else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                continuation.resume()
            }
        }
    }

    private static func milliseconds(_ duration: Duration) -> Double {
        let parts = duration.components
        return Double(parts.seconds) * 1_000 + Double(parts.attoseconds) / 1e15
    }
}
