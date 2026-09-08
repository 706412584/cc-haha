import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Native defense-in-depth for shortcuts that cross application boundaries or
/// terminate/lock processes. It operates on KeyMapping's parsed keycodes and
/// flags so every native alias (`esc`, `spacebar`, `opt`, etc.) has identical
/// policy behavior without maintaining a second string-normalization table.
enum SystemKeyPolicy {
    /// Missing is fail-closed (`false`); an explicitly present non-boolean is a
    /// malformed payload, never a truthy grant.
    static func parseGrant(_ value: JSONValue?) throws -> Bool {
        guard let value else { return false }
        guard case .bool(let granted) = value else {
            throw CUError(
                "bad_payload",
                "systemKeyCombos must be a boolean when provided"
            )
        }
        return granted
    }

    static func requiresGrant(_ sequence: String) throws -> Bool {
        try KeyMapping.parse(sequence).contains(where: isDangerous)
    }

    static func enforce(sequence: String, granted: Bool) throws {
        guard try !requiresGrant(sequence) || granted else {
            throw CUError(
                "grant_flag_required",
                "\"\(sequence)\" is a system-level shortcut. Enable system-level shortcuts in Computer Use settings before using it."
            )
        }
    }

    private static func isDangerous(_ chord: KeyMapping.Chord) -> Bool {
        // Fn is a transport-level modifier for these shortcuts, not a safety
        // escape hatch. Preserve every other extra modifier so ordinary chords
        // such as cmd+option+q and cmd+shift+a are not overblocked.
        var policyFlags = chord.flags
        policyFlags.remove(.maskSecondaryFn)

        switch chord.semanticKey {
        case "q":
            return policyFlags == .maskCommand
                || policyFlags == [.maskShift, .maskCommand]
                || policyFlags == [.maskControl, .maskCommand]
        case "tab":
            return policyFlags == .maskCommand
                || policyFlags == [.maskShift, .maskCommand]
        case "space":
            return policyFlags == .maskCommand
        case "escape":
            return policyFlags == [.maskAlternate, .maskCommand]
        default:
            return false
        }
    }
}
