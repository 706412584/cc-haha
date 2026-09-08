import AppKit
import CoreGraphics
import Foundation

/// Grants keyboard focus to a specific window of an already-resolved target.
///
/// NOTHING CALLS THIS. Read before you wire it back in.
/// -----------------------------------------------------
/// It was written because window-targeted events appeared to reach a Chromium/
/// CEF app only while that app held key focus: with the target in the
/// background the click was accepted and dropped, and after this call it
/// focused the field and typing landed.
///
/// That reading did not survive. A later session captured the target active
/// with its window key — the state this call exists to produce — and nine
/// window-bound clicks were discarded anyway. The actual defect was in the
/// events: the leading move claimed `clickState 1` and the press and release
/// carried different event numbers, so AppKit had no reason to read them as one
/// click. Fixed since; see `AXAction.ensureTargetAcceptsInput` for the full
/// account and `MouseClickStateTests` for the cover.
///
/// Kept, rather than deleted, because it is the fallback if background
/// actuation regresses on a real machine — and because what it does with a
/// private SPI is worth not having to rediscover. `SyntheticWindowFocus` is
/// what the input paths use now.
///
/// THIS DOES BRING THE TARGET FORWARD — do not describe it otherwise
/// -----------------------------------------------------------------
/// An earlier version of this comment claimed it "only makes the window key,
/// not frontmost". That is wrong, and it was measured: reading
/// `NSWorkspace.frontmostApplication` straight through System Events across the
/// call shows `Finder → NeteaseMusic`. `kCPSUserGenerated` is a real foreground
/// switch; it just skips the Dock animation.
///
/// So this is a foreground change, and callers must treat it as one. What it is
/// NOT is a *fallback*: it only ever names a target the caller already resolved
/// and was authorized for. There is no "target not found, use whatever is in
/// front" path — that is the thing that would amount to operating the user's
/// own session, and it stays forbidden.
///
/// Consequence worth knowing: the click immediately after a foreground change
/// can be swallowed as the activation click, so a caller that focuses and then
/// clicks in the same breath may need to let the switch settle first.
///
/// Everything is resolved by name at runtime; when a symbol is missing the call
/// is a no-op and actuation proceeds unfocused rather than failing.
enum WindowKeyFocus {
    private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
    private typealias SetFrontProcessWithOptions =
        @convention(c) (UnsafeMutableRawPointer, UInt32, UInt32) -> Int32

    /// `kCPSUserGenerated` — mark the focus change as user-initiated so the
    /// window server routes subsequent input to it the way it would after a
    /// real click.
    private static let userGeneratedOption: UInt32 = 0x2

    private static let getProcessForPID: GetProcessForPID? = {
        guard let handle = dlopen(nil, RTLD_LAZY),
              let symbol = dlsym(handle, "GetProcessForPID") else { return nil }
        return unsafeBitCast(symbol, to: GetProcessForPID.self)
    }()

    private static let setFrontProcess: SetFrontProcessWithOptions? = {
        // Exported by both CoreGraphics (as _CPS…) and SkyLight (as SLPS…);
        // try the process image first, then SkyLight directly.
        if let handle = dlopen(nil, RTLD_LAZY) {
            for name in ["_CPSSetFrontProcessWithOptions", "CPSSetFrontProcessWithOptions"] {
                if let symbol = dlsym(handle, name) {
                    return unsafeBitCast(symbol, to: SetFrontProcessWithOptions.self)
                }
            }
        }
        if let skylight = dlopen(
            "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
            RTLD_LAZY
        ), let symbol = dlsym(skylight, "SLPSSetFrontProcessWithOptions") {
            return unsafeBitCast(symbol, to: SetFrontProcessWithOptions.self)
        }
        return nil
    }()

    /// Whether the focus SPI resolved. Diagnostics only — absence degrades
    /// background actuation, it does not fail it.
    static var isAvailable: Bool { getProcessForPID != nil && setFrontProcess != nil }

    /// Does `pid` already own the frontmost application? Focus is only granted
    /// when it does not, so a target the user is already working in is left
    /// completely untouched.
    static func alreadyFrontmost(
        pid: pid_t,
        frontmostPid: pid_t? = NSWorkspace.shared.frontmostApplication?.processIdentifier
    ) -> Bool {
        frontmostPid == pid
    }

    /// Give `windowID` key focus. Returns false when the SPI is unavailable or
    /// the window server refused; callers proceed either way.
    @discardableResult
    static func grant(pid: pid_t, windowID: CGWindowID) -> Bool {
        guard pid > 0,
              windowID != kCGNullWindowID,
              let getPSN = getProcessForPID,
              let setFront = setFrontProcess else {
            return false
        }
        var psn = [UInt32](repeating: 0, count: 2)
        let psnStatus = psn.withUnsafeMutableBytes { getPSN(pid, $0.baseAddress!) }
        guard psnStatus == 0 else { return false }
        let status = psn.withUnsafeMutableBytes {
            setFront($0.baseAddress!, UInt32(windowID), userGeneratedOption)
        }
        return status == 0
    }

    /// Grant focus only if the target is not already frontmost.
    @discardableResult
    static func grantIfNeeded(pid: pid_t, windowID: CGWindowID) -> Bool {
        guard !alreadyFrontmost(pid: pid) else { return false }
        return grant(pid: pid, windowID: windowID)
    }
}
