// CUError.swift
//
// The single typed error for cu-helper. Every failure path in the CLI one-shot
// and the daemon funnels through `CUError`, which maps 1:1 onto the bridge's
// error envelope `{ ok: false, error: { message, code? } }`.
//
// The TS bridge (src/utils/computerUse/pythonBridge.ts) only reads
// `parsed.error?.message` to construct the thrown JS `Error`, so `message` is
// the load-bearing, human-readable field. `code` is a stable machine-readable
// discriminator carried alongside it (mirrors mac_helper.py's error codes) so
// that any future TS-side branching can switch on it without parsing strings.
//
// `Sendable` is required: a decoded request is routed onto `@MainActor` from
// the daemon's background IO queue, the router may `throw` a `CUError`, and the
// daemon hops the result (success or failure) back to the IO queue to write the
// response line. The error therefore crosses isolation boundaries and must be
// safe to send under Swift 6 strict concurrency. All stored properties are
// immutable value types (`String`), so the type is trivially `Sendable`.

import Foundation

/// A typed, `Sendable` error that serializes to the bridge envelope
/// `{ ok: false, error: { message, code? } }`.
///
/// Construct directly with `CUError(_:_:)` using one of the canonical
/// ``Code`` constants, or use one of the convenience factory methods
/// (e.g. ``notTrusted(_:)``) which apply a sensible default message.
public struct CUError: Error, Sendable {
    /// Stable machine-readable discriminator. One of the canonical codes
    /// declared in ``Code``. Serialized to `error.code` in the envelope.
    public let code: String

    /// Human-readable message. This is the value the TS bridge surfaces as the
    /// thrown JS `Error.message`, so it must be self-contained and actionable.
    public let message: String

    /// Designated initializer.
    ///
    /// - Parameters:
    ///   - code: A canonical code string. Prefer the ``Code`` constants so the
    ///     wire value stays consistent across modules.
    ///   - message: A self-contained, human-readable description of the failure.
    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    // MARK: - Canonical codes

    /// The canonical, stable set of error code strings emitted by cu-helper.
    ///
    /// These are referenced across `Capture`, `Injection`, `Displays`, `Apps`,
    /// `Permissions`, and `CommandRouter`. Using these constants (rather than
    /// raw string literals at each throw site) guarantees the wire contract
    /// cannot drift and that a typo becomes a compile error.
    public enum Code {
        /// No window/app could be resolved under the requested point, and no
        /// frontmost application exists to fall back to. Mouse hit-test ops.
        public static let noTarget = "no_target"

        /// Accessibility (AXIsProcessTrusted) is not granted to this binary, so
        /// cross-app input injection is blocked by the OS. Keyboard/mouse ops.
        public static let notTrusted = "not_trusted"

        /// Screen Recording (CGPreflightScreenCaptureAccess) is not granted, so
        /// ScreenCaptureKit cannot produce pixels. Screenshot/zoom/resolve ops.
        public static let screenRecordingDenied = "screen_recording_denied"

        /// The requested display id does not match any active display.
        public static let displayNotFound = "display_not_found"

        /// No on-screen window matched the requested target.
        public static let windowNotFound = "window_not_found"

        /// A `CGEvent` (or `CGEventSource`) could not be allocated, so the
        /// event could not be posted.
        public static let eventAlloc = "event_alloc"

        /// A key token in a key sequence could not be mapped to a keycode via
        /// the KeySym table or the current keyboard layout.
        public static let unknownKey = "unknown_key"

        /// Secure input mode is engaged (e.g. a password field), which suppresses
        /// synthetic keystrokes. Best-effort signal; not always detectable.
        public static let secureInput = "secure_input"

        /// The JSON payload was missing required fields or had the wrong shape.
        public static let badPayload = "bad_payload"

        /// The command verb is not recognized by the router.
        public static let badCommand = "bad_command"

        /// ScreenCaptureKit failed to produce an image for a reason other than a
        /// permission denial (e.g. no shareable content, capture timeout).
        public static let captureFailed = "capture_failed"

        /// A produced `CGImage` could not be encoded (e.g. to JPEG/PNG) or
        /// base64-encoded for transport.
        public static let encodeFailed = "encode_failed"
    }

    // MARK: - Convenience factories
    //
    // Each applies a sensible default message. Pass an explicit `message:` to
    // override with context (e.g. the offending display id or command name).

    /// `no_target` — no resolvable target window/app and no frontmost fallback.
    public static func noTarget(
        _ message: String = "No target application could be resolved for this action."
    ) -> CUError {
        CUError(Code.noTarget, message)
    }

    /// `not_trusted` — Accessibility permission is required and not granted.
    public static func notTrusted(
        _ message: String = "Accessibility permission is required. Grant it to this app in System Settings ▸ Privacy & Security ▸ Accessibility."
    ) -> CUError {
        CUError(Code.notTrusted, message)
    }

    /// `screen_recording_denied` — Screen Recording permission is not granted.
    public static func screenRecordingDenied(
        _ message: String = "Screen Recording permission is required. Grant it to this app in System Settings ▸ Privacy & Security ▸ Screen Recording."
    ) -> CUError {
        CUError(Code.screenRecordingDenied, message)
    }

    /// `display_not_found` — the requested display id does not exist.
    public static func displayNotFound(_ displayId: Int? = nil) -> CUError {
        if let displayId {
            return CUError(Code.displayNotFound, "Display \(displayId) was not found.")
        }
        return CUError(Code.displayNotFound, "The requested display was not found.")
    }

    /// `window_not_found` — no on-screen window matched the target.
    public static func windowNotFound(
        _ message: String = "No matching window was found."
    ) -> CUError {
        CUError(Code.windowNotFound, message)
    }

    /// `event_alloc` — a `CGEvent`/`CGEventSource` could not be created.
    public static func eventAlloc(
        _ message: String = "Failed to allocate a CGEvent for injection."
    ) -> CUError {
        CUError(Code.eventAlloc, message)
    }

    /// `unknown_key` — a key token could not be mapped to a keycode.
    public static func unknownKey(_ token: String) -> CUError {
        CUError(Code.unknownKey, "Unknown key: \"\(token)\".")
    }

    /// `secure_input` — secure input mode is suppressing keystrokes.
    public static func secureInput(
        _ message: String = "Secure input is enabled; keystrokes were suppressed by the system."
    ) -> CUError {
        CUError(Code.secureInput, message)
    }

    /// `bad_payload` — the JSON payload was malformed or missing fields.
    public static func badPayload(
        _ message: String = "The request payload was malformed or missing required fields."
    ) -> CUError {
        CUError(Code.badPayload, message)
    }

    /// `bad_command` — the command verb is not recognized.
    public static func badCommand(_ cmd: String) -> CUError {
        CUError(Code.badCommand, "Unknown command: \"\(cmd)\".")
    }

    /// `capture_failed` — ScreenCaptureKit produced no image (non-permission).
    public static func captureFailed(
        _ message: String = "Screen capture failed to produce an image."
    ) -> CUError {
        CUError(Code.captureFailed, message)
    }

    /// `encode_failed` — a produced image could not be encoded for transport.
    public static func encodeFailed(
        _ message: String = "Failed to encode the captured image."
    ) -> CUError {
        CUError(Code.encodeFailed, message)
    }
}

// MARK: - Diagnostics

extension CUError: CustomStringConvertible {
    /// `"[code] message"` — used only for local logging; never the wire format.
    /// The wire format is produced by `Envelope.fail(_:code:)` in JSONValue.swift.
    public var description: String { "[\(code)] \(message)" }
}

extension CUError: LocalizedError {
    /// Lets `error.localizedDescription` surface the message verbatim if a
    /// `CUError` is ever bridged through a generic `Error`/`NSError` path.
    public var errorDescription: String? { message }
}
