import ApplicationServices
import CoreGraphics
import Foundation

/// TCC (Transparency, Consent & Control) permission detection for the helper.
///
/// This is NOT one of the contract commands listed in the TS executor, but it is
/// load-bearing for:
///   - `Capture` gating its hot path on Screen Recording.
///   - `Injection` gating cross-app event posting on Accessibility (`accessibilityTrusted`).
///   - The `check_permissions` verb (mac_helper parity) used by onboarding / self-test
///     in BOTH CLI one-shot and daemon mode.
///
/// Reality check, baked into the implementation:
///   - Accessibility is queried via the canonical `AXIsProcessTrusted()` /
///     `AXIsProcessTrustedWithOptions(...)`. We FAIL CLOSED — any inability to read
///     the trust state is reported as not-trusted, never a misleading `true`, so the
///     desktop UI doesn't claim control works when it doesn't.
///   - Screen Recording is queried only via `CGPreflightScreenCaptureAccess()`.
///     Window-title visibility is not accepted as a substitute: a responsible
///     parent can expose titles even when this helper's own TCC identity cannot
///     capture. Permission reporting must match the capture hot path exactly.
///
/// NOTHING in this file ever moves the real cursor or posts an input event; it is pure
/// permission introspection. The only function that can surface OS UI is
/// `requestScreenRecording()`, which is reserved for explicit onboarding and is never
/// invoked on a hot path.
public enum Permissions {

    // MARK: Accessibility

    /// Whether THIS process is trusted for the Accessibility API (required for
    /// cross-app `CGEvent.postToPid` keyboard/mouse injection).
    ///
    /// - Parameter prompt: When `false` (default) this is a pure, side-effect-free
    ///   check via `AXIsProcessTrusted()` — no dialog, safe on every hot path. When
    ///   `true`, uses `AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])`,
    ///   which asks macOS to surface the "open System Settings ▸ Accessibility" prompt
    ///   if the process is not yet trusted. Reserve `prompt: true` for onboarding.
    ///
    /// Fails closed: if the trust query itself is unavailable, returns `false`.
    public static func accessibilityTrusted(prompt: Bool = false) -> Bool {
        if !prompt {
            // Side-effect-free fast path. Hot-path callers (Injection) use this.
            return AXIsProcessTrusted()
        }

        // Onboarding path: pass the documented prompt option so macOS can open the
        // Accessibility pane.
        //
        // We construct the option key from its stable string value rather than reading
        // the imported `kAXTrustedCheckOptionPrompt` global directly: that symbol is a
        // C `extern` and imports into Swift as a non-`Sendable` mutable `var`, which
        // trips Swift 6 strict-concurrency ("not concurrency-safe — shared mutable
        // state"). The literal is the documented, ABI-stable TCC option key and yields
        // an identical CFDictionary. Kept as a LOCAL (non-`Sendable` `CFString` can't be
        // a stored static under strict concurrency, but is fine as a function-local).
        let key = "AXTrustedCheckOptionPrompt" as CFString
        let options: CFDictionary = [key: kCFBooleanTrue as Any] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    // MARK: Screen Recording

    /// Explicitly ask macOS for Screen Recording (surfaces the system prompt and adds
    /// the binary to the Screen Recording pane). ONBOARDING ONLY — never call from a
    /// capture hot path; `Capture` must fail
    /// with `screen_recording_denied` instead of provoking a dialog mid-task.
    ///
    /// - Returns: the immediate post-request preflight result. Note macOS frequently
    ///   requires a process relaunch before the grant takes effect, so a `false` here
    ///   after the user grants is expected and not authoritative.
    @discardableResult
    public static func requestScreenRecording() -> Bool {
        // Side-effecting: may present the system Screen Recording prompt.
        _ = CGRequestScreenCaptureAccess()
        return CGPreflightScreenCaptureAccess()
    }

    /// Authoritative Screen Recording check. Reflects exactly what
    /// `CGPreflightScreenCaptureAccess()` reports, so the card, API snapshot and
    /// capture path never claim a grant the helper's own identity doesn't hold.
    public static func screenRecordingGrantedAuthoritative() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    // MARK: Snapshot (check_permissions verb)

    /// `{ "accessibility": Bool, "screenRecording": Bool }` — the `check_permissions`
    /// result shape (mac_helper parity). Side-effect-free; usable in either mode for
    /// onboarding / self-test. Uses the non-prompting Accessibility check so calling
    /// it never pops a dialog.
    public static func snapshot() -> JSONValue {
        snapshot(
            accessibility: accessibilityTrusted(prompt: false),
            screenRecordingPreflight: screenRecordingGrantedAuthoritative()
        )
    }

    /// Pure encoder used to lock the permission contract in tests. The caller
    /// supplies the authoritative preflight result; no secondary signal may
    /// upgrade a denial.
    static func snapshot(
        accessibility: Bool,
        screenRecordingPreflight: Bool
    ) -> JSONValue {
        .object([
            "accessibility": .bool(accessibility),
            "screenRecording": .bool(screenRecordingPreflight),
        ])
    }
}
