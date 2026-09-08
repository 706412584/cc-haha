import Darwin
import Foundation
import Security

struct AttestedProcess: Equatable, Sendable {
    var pid: pid_t
    var parentPID: pid_t
    var executablePath: String
    var identifier: String
    var teamIdentifier: String?
    var leafCertificate: Data?
    var signatureValid: Bool
}

enum HelperAuthorizationDecision: Equatable, Sendable {
    case allow
    case deny
}

/// Pure, deny-by-default authorization policy for every native helper entrypoint.
/// Live process inspection is deliberately kept outside this type so signature,
/// ancestry and command policy stay exhaustively unit-testable.
enum HelperClientPolicy {
    static let helperIdentifier = "dev.cchaha.cu-helper"
    static let desktopIdentifier = "com.claude-code-haha.desktop"
    static let sidecarIdentifier = "com.claude-code-haha.desktop.sidecar"

    private static let daemonCommands: Set<String> = [
        // Codex semantic tool contract. `resolve_app_target` is the mandatory
        // read-only authorization preflight used before the ten public tools.
        "list_apps", "list_installed_apps", "resolve_app_target", "get_app_state", "click",
        "set_value", "select_text", "perform_secondary_action", "scroll",
        "drag", "press_key", "type_text", "paste",
        // Private lifecycle / visible-overlay / permission and input diagnostics.
        "ping", "shutdown", "overlay_show", "overlay_hide", "turn_end",
        "check_permissions", "input_monitor_state", "focus_monitor_state", "held_input_state",
        "last_injection_state",
    ]

    static func isDaemonCommandAllowed(_ command: String) -> Bool {
        daemonCommands.contains(command)
    }

    static func authorizeDaemon(
        peer: AttestedProcess,
        ancestors: [AttestedProcess],
        helper: AttestedProcess
    ) -> HelperAuthorizationDecision {
        let chain = [peer] + ancestors
        guard chain.count == 2 || chain.count == 3,
              validParentLinks(chain),
              validSignerChain(chain, helper: helper),
              validDesktopChain(chain, allowServerDirect: true) else {
            return .deny
        }
        return .allow
    }

    /// Reverse half of mutual daemon authentication. The signed verifier is a
    /// fresh packaged helper process; the candidate is the kernel-identified
    /// peer on the sidecar's connected AF_UNIX socket.
    static func authorizeDaemonPeer(
        peer: AttestedProcess,
        verifier: AttestedProcess,
        expectedExecutablePath: String
    ) -> HelperAuthorizationDecision {
        guard verifier.signatureValid,
              verifier.identifier == helperIdentifier,
              let leaf = verifier.leafCertificate,
              !leaf.isEmpty,
              peer.signatureValid,
              peer.identifier == helperIdentifier,
              peer.executablePath == expectedExecutablePath,
              peer.teamIdentifier == verifier.teamIdentifier,
              peer.leafCertificate == leaf else {
            return .deny
        }
        return .allow
    }

    static func authorizeOneShot(
        command: String,
        processChain: [AttestedProcess],
        helper: AttestedProcess
    ) -> HelperAuthorizationDecision {
        if command == "help" || command == "--help" || command == "-h" {
            return .allow
        }

        let helperPrefixCounts: ClosedRange<Int>
        switch command {
        case "request-access", "request_access":
            // The private disclaim API is best-effort. Accept either the direct
            // helper or disclaimed worker -> helper supervisor, then desktop.
            helperPrefixCounts = 1...2
        case "attest_daemon_peer":
            // Peer verification never touches TCC and deliberately skips the
            // disclaim supervisor. Keeping this process direct makes SIGKILL a
            // complete timeout boundary: no reparented worker can retain fd 3.
            helperPrefixCounts = 1...1
        case "check_permissions":
            // Card + fresh probe each contribute one helper process, and each
            // may contribute a second supervisor when disclaim succeeds.
            helperPrefixCounts = 2...4
        default:
            return .deny
        }

        guard processChain.count >= helperPrefixCounts.lowerBound + 2,
              validParentLinks(processChain),
              validSignerChain(processChain, helper: helper) else {
            return .deny
        }

        for helperPrefixCount in helperPrefixCounts {
            guard processChain.count >= helperPrefixCount + 2 else { continue }
            let helperPrefix = processChain.prefix(helperPrefixCount)
            guard helperPrefix.allSatisfy({ isExactHelper($0, helper: helper) }) else {
                continue
            }
            let desktopTail = Array(processChain.dropFirst(helperPrefixCount))
            if validDesktopChain(desktopTail, allowServerDirect: true) {
                return .allow
            }
        }
        return .deny
    }

    private static func validParentLinks(_ chain: [AttestedProcess]) -> Bool {
        guard chain.count >= 2 else { return false }
        return zip(chain, chain.dropFirst()).allSatisfy { child, parent in
            child.pid > 0 && parent.pid > 0 && child.parentPID == parent.pid
        }
    }

    private static func validSignerChain(
        _ chain: [AttestedProcess],
        helper: AttestedProcess
    ) -> Bool {
        guard helper.signatureValid,
              helper.identifier == helperIdentifier,
              let leaf = helper.leafCertificate,
              !leaf.isEmpty else {
            return false
        }
        let team = helper.teamIdentifier
        return chain.allSatisfy {
            $0.signatureValid
                && $0.teamIdentifier == team
                && $0.leafCertificate == leaf
        }
    }

    private static func isExactHelper(
        _ process: AttestedProcess,
        helper: AttestedProcess
    ) -> Bool {
        process.identifier == helperIdentifier
            && process.executablePath == helper.executablePath
    }

    /// Accept `CLI -> server -> host`, or `server -> host` only for permission
    /// card launch from the server API. Both sidecars are the same packaged,
    /// signed executable and must sit at the exact asar-unpacked path of `host`.
    private static func validDesktopChain(
        _ chain: [AttestedProcess],
        allowServerDirect: Bool
    ) -> Bool {
        guard chain.count == 3 || (allowServerDirect && chain.count == 2),
              let host = chain.last,
              host.identifier == desktopIdentifier,
              let appRoot = desktopAppRoot(for: host.executablePath) else {
            return false
        }

        let sidecars = chain.dropLast()
        guard !sidecars.isEmpty else { return false }
        for sidecar in sidecars {
            guard sidecar.identifier == sidecarIdentifier,
                  isExpectedSidecarPath(sidecar.executablePath, appRoot: appRoot) else {
                return false
            }
        }
        if sidecars.count == 2 {
            guard sidecars.first?.executablePath == sidecars.last?.executablePath else {
                return false
            }
        }
        return true
    }

    private static func desktopAppRoot(for hostPath: String) -> String? {
        let marker = "/Contents/MacOS/"
        guard let range = hostPath.range(of: marker, options: .backwards),
              range.lowerBound > hostPath.startIndex,
              range.upperBound < hostPath.endIndex else {
            return nil
        }
        let root = String(hostPath[..<range.lowerBound])
        guard root.hasSuffix(".app") else { return nil }
        return root
    }

    private static func isExpectedSidecarPath(
        _ path: String,
        appRoot: String
    ) -> Bool {
        let directory = appRoot
            + "/Contents/Resources/app.asar.unpacked/src-tauri/binaries/"
        guard path.hasPrefix(directory) else { return false }
        let name = String(path.dropFirst(directory.count))
        return name == "claude-sidecar-aarch64-apple-darwin"
            || name == "claude-sidecar-x86_64-apple-darwin"
    }
}

struct DaemonPeerIdentity: Sendable {
    let pid: pid_t
    let auditToken: Data?

    /// Read peer identity from the connected AF_UNIX fd. Request JSON and
    /// filesystem ownership are intentionally irrelevant: these values are
    /// kernel-authenticated properties of the accepted socket.
    static func read(from fd: Int32) throws -> DaemonPeerIdentity {
        var pid: pid_t = 0
        var pidLength = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidLength) == 0,
              pidLength == MemoryLayout<pid_t>.size,
              pid > 0 else {
            throw ClientAttestationError.kernelPeerCredentials
        }

        var token = audit_token_t()
        var tokenLength = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getsockopt(
            fd,
            SOL_LOCAL,
            LOCAL_PEERTOKEN,
            &token,
            &tokenLength
        ) == 0,
              tokenLength == MemoryLayout<audit_token_t>.size else {
            throw ClientAttestationError.kernelPeerCredentials
        }
        let tokenData = withUnsafeBytes(of: &token) { Data($0) }
        return DaemonPeerIdentity(pid: pid, auditToken: tokenData)
    }
}

enum ClientAttestationError: Error, Equatable {
    case kernelPeerCredentials
    case processUnavailable(pid_t)
    case codeUnavailable(pid_t, OSStatus)
    case signingInformationUnavailable(pid_t, OSStatus)
    case processChanged(pid_t)
}

enum ProcessAttestor {
    private struct KernelProcessIdentity: Equatable {
        let parentPID: pid_t
        let startSeconds: UInt64
        let startMicroseconds: UInt64
        let executablePath: String
    }

    static func attest(
        pid: pid_t,
        auditToken: Data? = nil
    ) throws -> AttestedProcess {
        guard pid > 0 else { throw ClientAttestationError.processUnavailable(pid) }
        let before = try kernelIdentity(pid: pid, auditToken: auditToken)
        let code = try dynamicCode(pid: pid, auditToken: auditToken)
        let validation = SecCodeCheckValidity(
            code,
            SecCSFlags(rawValue: kSecCSStrictValidate),
            nil
        )

        var staticCode: SecStaticCode?
        let staticStatus = SecCodeCopyStaticCode(
            code,
            SecCSFlags(rawValue: 0),
            &staticCode
        )
        guard staticStatus == errSecSuccess, let staticCode else {
            throw ClientAttestationError.signingInformationUnavailable(
                pid,
                staticStatus
            )
        }

        var rawInfo: CFDictionary?
        let infoStatus = SecCodeCopySigningInformation(
            staticCode,
            SecCSFlags(rawValue: kSecCSSigningInformation),
            &rawInfo
        )
        guard infoStatus == errSecSuccess,
              let info = rawInfo as? [CFString: Any] else {
            throw ClientAttestationError.signingInformationUnavailable(
                pid,
                infoStatus
            )
        }

        let after = try kernelIdentity(pid: pid, auditToken: auditToken)
        guard before == after else {
            throw ClientAttestationError.processChanged(pid)
        }

        let certificates = info[kSecCodeInfoCertificates] as? [SecCertificate]
        let leaf = certificates?.first.map { SecCertificateCopyData($0) as Data }
        return AttestedProcess(
            pid: pid,
            parentPID: before.parentPID,
            executablePath: before.executablePath,
            identifier: info[kSecCodeInfoIdentifier] as? String ?? "",
            teamIdentifier: info[kSecCodeInfoTeamIdentifier] as? String,
            leafCertificate: leaf,
            signatureValid: validation == errSecSuccess
        )
    }

    /// Attest the process and every parent until the signed desktop host is
    /// reached. The fixed depth keeps malformed/cyclic ancestry bounded.
    static func chain(
        startingAt pid: pid_t,
        firstAuditToken: Data? = nil,
        maximumDepth: Int = 12
    ) throws -> [AttestedProcess] {
        guard maximumDepth > 0 else { return [] }
        var result: [AttestedProcess] = []
        var seen: Set<pid_t> = []
        var currentPID = pid
        var auditToken = firstAuditToken

        while currentPID > 1 && result.count < maximumDepth {
            guard seen.insert(currentPID).inserted else {
                throw ClientAttestationError.processChanged(currentPID)
            }
            let process = try attest(pid: currentPID, auditToken: auditToken)
            result.append(process)
            if process.identifier == HelperClientPolicy.desktopIdentifier {
                return result
            }
            currentPID = process.parentPID
            auditToken = nil
        }
        return result
    }

    private static func dynamicCode(
        pid: pid_t,
        auditToken: Data?
    ) throws -> SecCode {
        let attributes: CFDictionary
        if let auditToken {
            attributes = [kSecGuestAttributeAudit: auditToken as CFData]
                as CFDictionary
        } else {
            attributes = [kSecGuestAttributePid: NSNumber(value: pid)]
                as CFDictionary
        }

        var code: SecCode?
        let status = SecCodeCopyGuestWithAttributes(
            nil,
            attributes,
            SecCSFlags(rawValue: 0),
            &code
        )
        guard status == errSecSuccess, let code else {
            throw ClientAttestationError.codeUnavailable(pid, status)
        }
        return code
    }

    private static func kernelIdentity(
        pid: pid_t,
        auditToken: Data?
    ) throws -> KernelProcessIdentity {
        var bsd = proc_bsdinfo()
        let count = withUnsafeMutablePointer(to: &bsd) { pointer in
            proc_pidinfo(
                pid,
                PROC_PIDTBSDINFO,
                0,
                pointer,
                Int32(MemoryLayout<proc_bsdinfo>.size)
            )
        }
        guard count == MemoryLayout<proc_bsdinfo>.size else {
            throw ClientAttestationError.processUnavailable(pid)
        }

        var pathBuffer = [CChar](repeating: 0, count: Int(4 * MAXPATHLEN))
        let pathLength: Int32
        if let auditToken {
            guard auditToken.count == MemoryLayout<audit_token_t>.size else {
                throw ClientAttestationError.kernelPeerCredentials
            }
            var token = audit_token_t()
            _ = withUnsafeMutableBytes(of: &token) { destination in
                auditToken.copyBytes(to: destination)
            }
            pathLength = proc_pidpath_audittoken(
                &token,
                &pathBuffer,
                UInt32(pathBuffer.count)
            )
        } else {
            pathLength = proc_pidpath(
                pid,
                &pathBuffer,
                UInt32(pathBuffer.count)
            )
        }
        guard pathLength > 0 else {
            throw ClientAttestationError.processUnavailable(pid)
        }

        let pathBytes = pathBuffer
            .prefix { $0 != 0 }
            .map { UInt8(bitPattern: $0) }
        return KernelProcessIdentity(
            parentPID: pid_t(bsd.pbi_ppid),
            startSeconds: UInt64(bsd.pbi_start_tvsec),
            startMicroseconds: UInt64(bsd.pbi_start_tvusec),
            executablePath: String(decoding: pathBytes, as: UTF8.self)
        )
    }
}

enum HelperRuntimeAuthorization {
    static func authorizeDaemonConnection(fd: Int32) -> Bool {
        do {
            let peer = try DaemonPeerIdentity.read(from: fd)
            let helper = try ProcessAttestor.attest(pid: getpid())
            let chain = try ProcessAttestor.chain(
                startingAt: peer.pid,
                firstAuditToken: peer.auditToken
            )
            guard let first = chain.first, first.pid == peer.pid else {
                return false
            }
            return HelperClientPolicy.authorizeDaemon(
                peer: first,
                ancestors: Array(chain.dropFirst()),
                helper: helper
            ) == .allow
        } catch {
            return false
        }
    }

    static func authorizeOneShot(command: String) -> Bool {
        if command == "help" || command == "--help" || command == "-h" {
            return true
        }
        do {
            let helper = try ProcessAttestor.attest(pid: getpid())
            let chain = try ProcessAttestor.chain(startingAt: getpid())
            return HelperClientPolicy.authorizeOneShot(
                command: command,
                processChain: chain,
                helper: helper
            ) == .allow
        } catch {
            return false
        }
    }

    static func authorizeDaemonPeer(
        pid: pid_t,
        auditToken: Data,
        expectedExecutablePath: String
    ) -> Bool {
        do {
            let verifier = try ProcessAttestor.attest(pid: getpid())
            let peer = try ProcessAttestor.attest(
                pid: pid,
                auditToken: auditToken
            )
            return HelperClientPolicy.authorizeDaemonPeer(
                peer: peer,
                verifier: verifier,
                expectedExecutablePath: expectedExecutablePath
            ) == .allow
        } catch {
            return false
        }
    }

    /// Reverse-authenticate the daemon on an inherited connected socket. The
    /// signed sidecar duplicates its socket into fd 3 of a fresh verifier
    /// process, so LOCAL_PEERPID/LOCAL_PEERTOKEN are read by native code rather
    /// than by a hardened-runtime-incompatible dynamic call trampoline.
    static func authorizeDaemonPeer(
        fd: Int32,
        expectedExecutablePath: String
    ) -> (pid: pid_t, trusted: Bool)? {
        do {
            let peer = try DaemonPeerIdentity.read(from: fd)
            guard let auditToken = peer.auditToken else { return nil }
            return (
                peer.pid,
                authorizeDaemonPeer(
                    pid: peer.pid,
                    auditToken: auditToken,
                    expectedExecutablePath: expectedExecutablePath
                )
            )
        } catch {
            return nil
        }
    }
}
