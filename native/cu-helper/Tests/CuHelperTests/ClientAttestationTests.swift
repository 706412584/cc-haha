import Foundation
import Testing
@testable import cc_haha_computer_use

@Suite("Computer Use client attestation policy")
struct ClientAttestationTests {
    private let team = "TEAM123456"
    private let leaf = Data([0xCA, 0xFE])
    private let appRoot = "/Applications/Claude Code Haha.app"

    private var sidecarPath: String {
        appRoot
            + "/Contents/Resources/app.asar.unpacked/src-tauri/binaries/"
            + "claude-sidecar-aarch64-apple-darwin"
    }

    private func process(
        pid: pid_t,
        parentPID: pid_t,
        path: String,
        identifier: String,
        teamIdentifier: String? = "TEAM123456",
        leafCertificate: Data? = Data([0xCA, 0xFE]),
        signatureValid: Bool = true
    ) -> AttestedProcess {
        AttestedProcess(
            pid: pid,
            parentPID: parentPID,
            executablePath: path,
            identifier: identifier,
            teamIdentifier: teamIdentifier,
            leafCertificate: leafCertificate,
            signatureValid: signatureValid
        )
    }

    private var helper: AttestedProcess {
        process(
            pid: 900,
            parentPID: 1,
            path: "/Users/test/Library/Application Support/Claude Code Haha/"
                + "cc-haha-computer-use.app/Contents/MacOS/cc-haha-computer-use",
            identifier: HelperClientPolicy.helperIdentifier
        )
    }

    private var host: AttestedProcess {
        process(
            pid: 300,
            parentPID: 1,
            path: appRoot + "/Contents/MacOS/Claude Code Haha",
            identifier: HelperClientPolicy.desktopIdentifier
        )
    }

    private var server: AttestedProcess {
        process(
            pid: 200,
            parentPID: 300,
            path: sidecarPath,
            identifier: HelperClientPolicy.sidecarIdentifier
        )
    }

    private var cli: AttestedProcess {
        process(
            pid: 100,
            parentPID: 200,
            path: sidecarPath,
            identifier: HelperClientPolicy.sidecarIdentifier
        )
    }

    private func helperProcess(pid: pid_t, parentPID: pid_t) -> AttestedProcess {
        process(
            pid: pid,
            parentPID: parentPID,
            path: helper.executablePath,
            identifier: HelperClientPolicy.helperIdentifier
        )
    }

    @Test("accepts only the exact packaged CLI -> server -> Electron chain")
    func acceptsPackagedDaemonChain() {
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: cli,
                ancestors: [server, host],
                helper: helper
            ) == .allow
        )

        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: server,
                ancestors: [host],
                helper: helper
            ) == .allow
        )
    }

    @Test("rejects terminal, source and path-spoofed daemon peers")
    func rejectsUnpackagedDaemonPeers() {
        let terminal = process(
            pid: 100,
            parentPID: 200,
            path: "/opt/homebrew/bin/bun",
            identifier: "bun"
        )
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: terminal,
                ancestors: [server, host],
                helper: helper
            ) == .deny
        )

        var spoofed = cli
        spoofed.executablePath = appRoot + "/Contents/Resources/claude-sidecar-aarch64-apple-darwin"
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: spoofed,
                ancestors: [server, host],
                helper: helper
            ) == .deny
        )
    }

    @Test("requires an unbroken parent PID chain")
    func rejectsBrokenParentChain() {
        var wrongServer = server
        wrongServer.parentPID = 777
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: cli,
                ancestors: [wrongServer, host],
                helper: helper
            ) == .deny
        )
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: cli,
                ancestors: [host],
                helper: helper
            ) == .deny
        )
    }

    @Test("requires valid signatures and the helper's exact Team ID and leaf signer")
    func rejectsSignatureMismatch() {
        var invalid = cli
        invalid.signatureValid = false
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: invalid,
                ancestors: [server, host],
                helper: helper
            ) == .deny
        )

        var selfSignedHelper = helper
        selfSignedHelper.teamIdentifier = nil
        var selfSignedCli = cli
        selfSignedCli.teamIdentifier = nil
        var selfSignedServer = server
        selfSignedServer.teamIdentifier = nil
        var selfSignedHost = host
        selfSignedHost.teamIdentifier = nil
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: selfSignedCli,
                ancestors: [selfSignedServer, selfSignedHost],
                helper: selfSignedHelper
            ) == .allow
        )

        var adHoc = cli
        adHoc.teamIdentifier = nil
        adHoc.leafCertificate = nil
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: adHoc,
                ancestors: [server, host],
                helper: helper
            ) == .deny
        )

        var otherTeam = server
        otherTeam.teamIdentifier = "OTHERTEAM1"
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: cli,
                ancestors: [otherTeam, host],
                helper: helper
            ) == .deny
        )

        var otherLeaf = host
        otherLeaf.leafCertificate = Data([0xBA, 0xAD])
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: cli,
                ancestors: [server, otherLeaf],
                helper: helper
            ) == .deny
        )
    }

    @Test("request-access requires the disclaimed helper pair above a trusted desktop chain")
    func requestAccessPolicy() {
        let supervisor = helperProcess(pid: 401, parentPID: cli.pid)
        let child = helperProcess(pid: 400, parentPID: supervisor.pid)
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: "request-access",
                processChain: [child, supervisor, cli, server, host],
                helper: helper
            ) == .allow
        )
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: "request-access",
                processChain: [
                    helperProcess(pid: 400, parentPID: cli.pid),
                    cli, server, host,
                ],
                helper: helper
            ) == .allow
        )
    }

    @Test("reverse daemon peer attestation requires an exact signed helper process")
    func reverseDaemonPeerPolicy() {
        #expect(
            HelperClientPolicy.authorizeDaemonPeer(
                peer: helper,
                verifier: helper,
                expectedExecutablePath: helper.executablePath
            ) == .allow
        )

        var wrongPath = helper
        wrongPath.executablePath = "/tmp/cc-haha-computer-use"
        #expect(
            HelperClientPolicy.authorizeDaemonPeer(
                peer: wrongPath,
                verifier: helper,
                expectedExecutablePath: helper.executablePath
            ) == .deny
        )

        var wrongSigner = helper
        wrongSigner.leafCertificate = Data([0xBA, 0xAD])
        #expect(
            HelperClientPolicy.authorizeDaemonPeer(
                peer: wrongSigner,
                verifier: helper,
                expectedExecutablePath: helper.executablePath
            ) == .deny
        )
    }

    @Test("peer attestation command requires the signed helper and desktop chain")
    func reverseDaemonPeerCommandPolicy() {
        let directVerifier = helperProcess(pid: 400, parentPID: server.pid)
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: "attest_daemon_peer",
                processChain: [directVerifier, server, host],
                helper: helper
            ) == .allow
        )
        let cliVerifier = helperProcess(pid: 399, parentPID: cli.pid)
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: "attest_daemon_peer",
                processChain: [cliVerifier, cli, server, host],
                helper: helper
            ) == .allow
        )

        let supervisor = helperProcess(pid: 401, parentPID: server.pid)
        let disclaimedWorker = helperProcess(pid: 400, parentPID: supervisor.pid)
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: "attest_daemon_peer",
                processChain: [disclaimedWorker, supervisor, server, host],
                helper: helper
            ) == .deny
        )
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: "attest_daemon_peer",
                processChain: [server, host],
                helper: helper
            ) == .deny
        )
    }

    @Test("daemon peer verifier skips the TCC disclaim supervisor")
    func reverseDaemonPeerDisclaimPolicy() {
        #expect(shouldDisclaimHelper(command: "attest_daemon_peer") == false)
        #expect(shouldDisclaimHelper(command: "daemon") == false)
        #expect(shouldDisclaimHelper(command: "help") == false)
        #expect(shouldDisclaimHelper(command: "request-access") == true)
        #expect(shouldDisclaimHelper(command: "check_permissions") == true)
    }

    @Test("permission snapshot is restricted to a permission-card fresh helper child")
    func permissionProbePolicy() {
        let cardSupervisor = helperProcess(pid: 403, parentPID: cli.pid)
        let cardChild = helperProcess(pid: 402, parentPID: cardSupervisor.pid)
        let probeSupervisor = helperProcess(pid: 401, parentPID: cardChild.pid)
        let probeChild = helperProcess(pid: 400, parentPID: probeSupervisor.pid)
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: "check_permissions",
                processChain: [
                    probeChild, probeSupervisor, cardChild, cardSupervisor,
                    cli, server, host,
                ],
                helper: helper
            ) == .allow
        )

        for compatibleChain in [
            [cardChild, cardSupervisor, cli, server, host],
            [probeSupervisor, cardChild, cardSupervisor, cli, server, host],
        ] {
            #expect(
                HelperClientPolicy.authorizeOneShot(
                    command: "check_permissions",
                    processChain: compatibleChain,
                    helper: helper
                ) == .allow
            )
        }
    }

    @Test("help is public while every other one-shot command fails closed")
    func oneShotCommandAllowlist() {
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: "help",
                processChain: [],
                helper: helper
            ) == .allow
        )
        for command in [
            "screenshot", "click", "type_text", "read_clipboard",
            "write_clipboard", "open_app", "list_apps", "list_installed_apps",
        ] {
            #expect(
                HelperClientPolicy.authorizeOneShot(
                    command: command,
                    processChain: [cli, server, host],
                    helper: helper
                ) == .deny
            )
        }
    }

    @Test("daemon exposes only the semantic contract and required control diagnostics")
    func daemonCommandAllowlist() {
        let allowed = [
            "list_apps", "list_installed_apps", "resolve_app_target", "get_app_state", "click",
            "set_value", "select_text", "perform_secondary_action", "scroll",
            "drag", "press_key", "type_text", "paste", "ping", "shutdown",
            "overlay_show", "overlay_hide", "turn_end", "check_permissions",
            "input_monitor_state", "held_input_state",
        ]
        for command in allowed {
            #expect(HelperClientPolicy.isDaemonCommandAllowed(command))
        }

        for command in [
            "screenshot", "resolve_prepare_capture", "zoom", "key", "type",
            "hold_key", "paste_clipboard", "read_clipboard", "write_clipboard",
            "move_mouse", "mouse_down", "mouse_up", "cursor_position",
            "open_app", "list_running_apps",
        ] {
            #expect(!HelperClientPolicy.isDaemonCommandAllowed(command))
        }
    }

    @Test("focus diagnostics require an authenticated daemon and do not open unknown commands")
    func focusMonitorDiagnosticPolicy() {
        let command = "focus_monitor_state"
        #expect(HelperClientPolicy.isDaemonCommandAllowed(command))
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: cli, ancestors: [server, host], helper: helper
            ) == .allow
        )

        var unsignedPeer = cli
        unsignedPeer.signatureValid = false
        #expect(
            HelperClientPolicy.authorizeDaemon(
                peer: unsignedPeer, ancestors: [server, host], helper: helper
            ) == .deny
        )
        #expect(
            HelperClientPolicy.authorizeOneShot(
                command: command,
                processChain: [helperProcess(pid: 400, parentPID: cli.pid), cli, server, host],
                helper: helper
            ) == .deny
        )

        for unknown in ["", "unknown_command", "focus_monitor_state_extra", "focus_monitor_state ", "FOCUS_MONITOR_STATE"] {
            #expect(!HelperClientPolicy.isDaemonCommandAllowed(unknown))
        }
    }

    @Test("live process attestation reads a stable executable identity")
    func liveSelfAttestationHook() throws {
        let current = try ProcessAttestor.attest(pid: getpid())
        #expect(current.pid == getpid())
        #expect(current.parentPID > 0)
        #expect(!current.executablePath.isEmpty)
        #expect(!current.identifier.isEmpty)
        #expect(current.signatureValid)
    }

    @Test("daemon peer credentials come from the kernel socket, not request data")
    func kernelPeerCredentialHook() throws {
        var sockets: [Int32] = [-1, -1]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0)
        defer {
            if sockets[0] >= 0 { close(sockets[0]) }
            if sockets[1] >= 0 { close(sockets[1]) }
        }

        let peer = try DaemonPeerIdentity.read(from: sockets[0])
        #expect(peer.pid == getpid())
        #expect(peer.auditToken != nil)
    }

    @Test("a raw terminal socket and direct one-shot invocation fail live attestation")
    func liveAttackProofHooks() throws {
        var sockets: [Int32] = [-1, -1]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets) == 0)
        defer {
            if sockets[0] >= 0 { close(sockets[0]) }
            if sockets[1] >= 0 { close(sockets[1]) }
        }

        #expect(!HelperRuntimeAuthorization.authorizeDaemonConnection(fd: sockets[0]))
        #expect(!HelperRuntimeAuthorization.authorizeOneShot(command: "check_permissions"))
        #expect(!HelperRuntimeAuthorization.authorizeOneShot(command: "request-access"))
        #expect(HelperRuntimeAuthorization.authorizeOneShot(command: "help"))
    }
}
