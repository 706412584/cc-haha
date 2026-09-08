import AppKit
import Foundation

struct AppTargetCandidate: Sendable, Equatable {
    let pid: pid_t
    let bundleIdentifier: String
    let bundleURL: URL?
    let localizedName: String?
    let executableName: String?
    let isMainApplicationProcess: Bool

    init(
        pid: pid_t,
        bundleIdentifier: String,
        bundleURL: URL?,
        localizedName: String?,
        executableName: String?,
        isMainApplicationProcess: Bool? = nil
    ) {
        self.pid = pid
        self.bundleIdentifier = bundleIdentifier
        self.bundleURL = bundleURL
        self.localizedName = localizedName
        self.executableName = executableName
        self.isMainApplicationProcess = isMainApplicationProcess ?? Self.inferMainApplicationProcess(
            bundleURL: bundleURL,
            executableName: executableName
        )
    }

    private static func inferMainApplicationProcess(
        bundleURL: URL?,
        executableName: String?
    ) -> Bool {
        guard let bundleURL, let executableName else { return false }
        let bundleName = bundleURL.deletingPathExtension().lastPathComponent
        return executableName.caseInsensitiveCompare(bundleName) == .orderedSame
    }
}

private enum RunningAppInstanceKey: Hashable {
    case bundle(identifier: String, path: String)
    case process(pid_t)
}

struct ResolvedAppTarget: Sendable, Equatable {
    let pid: pid_t
    let bundleIdentifier: String
    let bundleURL: URL?
}

/// Read-only metadata for an installed application that may not be running.
/// Kept separate from ``ResolvedAppTarget`` so a path can never be mistaken for
/// a live process and accidentally become an injection target.
struct InstalledAppTarget: Sendable, Equatable {
    let bundleIdentifier: String
    let displayName: String
    let bundleURL: URL
}

enum UnlaunchedAppTarget: Sendable, Equatable {
    case running(ResolvedAppTarget)
    case installed(InstalledAppTarget)
}

enum AppTargetSelector: Sendable, Equatable {
    case pid(pid_t)
    case bundleIdentifier(String)
    case app(String)

    var launchIdentifier: String? {
        switch self {
        case .pid:
            return nil
        case .bundleIdentifier(let identifier), .app(let identifier):
            return identifier
        }
    }
}

@MainActor
enum AppTargetResolver {
    static func candidates() -> [AppTargetCandidate] {
        NSWorkspace.shared.runningApplications.compactMap { app in
            guard app.processIdentifier > 0,
                  app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
                  let bundleIdentifier = app.bundleIdentifier,
                  !bundleIdentifier.isEmpty else { return nil }
            let bundleURL = app.bundleURL?.standardizedFileURL
            let executableURL = app.executableURL?.standardizedFileURL
            return AppTargetCandidate(
                pid: app.processIdentifier,
                bundleIdentifier: bundleIdentifier,
                bundleURL: bundleURL,
                localizedName: app.localizedName,
                executableName: executableURL?.deletingPathExtension().lastPathComponent,
                isMainApplicationProcess: bundleURL
                    .flatMap { Bundle(url: $0)?.executableURL?.standardizedFileURL }
                    .map { $0 == executableURL }
            )
        }
    }

    nonisolated static func match(
        identifier raw: String,
        candidates: [AppTargetCandidate]
    ) throws -> ResolvedAppTarget {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw CUError("no_target", "App identifier is empty")
        }
        let normalizedPath = value.hasPrefix("/")
            ? URL(fileURLWithPath: value).standardizedFileURL.path
            : nil
        let matches: [AppTargetCandidate]
        if let normalizedPath {
            matches = candidates.filter {
                $0.bundleURL?.standardizedFileURL.path == normalizedPath
            }
        } else {
            let name = URL(fileURLWithPath: value).deletingPathExtension().lastPathComponent
            matches = candidates.filter { candidate in
                if candidate.bundleIdentifier.caseInsensitiveCompare(value) == .orderedSame {
                    return true
                }
                return [
                    candidate.localizedName,
                    candidate.executableName,
                    candidate.bundleURL?.deletingPathExtension().lastPathComponent,
                ]
                .compactMap { $0 }
                .contains { $0.caseInsensitiveCompare(name) == .orderedSame }
            }
        }
        guard !matches.isEmpty else {
            throw CUError("target_not_running", "No running app matches '\(raw)'")
        }
        let match = try selectApplicationProcess(
            from: matches,
            identifier: raw,
            fullPathWasProvided: normalizedPath != nil
        )
        return ResolvedAppTarget(
            pid: match.pid,
            bundleIdentifier: match.bundleIdentifier,
            bundleURL: match.bundleURL
        )
    }

    private nonisolated static func selectApplicationProcess(
        from matches: [AppTargetCandidate],
        identifier: String,
        fullPathWasProvided: Bool
    ) throws -> AppTargetCandidate {
        if matches.count == 1, let match = matches.first {
            return match
        }

        let instances = Dictionary(grouping: matches) { candidate in
            guard let path = candidate.bundleURL?.standardizedFileURL.path else {
                return RunningAppInstanceKey.process(candidate.pid)
            }
            return RunningAppInstanceKey.bundle(
                identifier: candidate.bundleIdentifier.lowercased(),
                path: path
            )
        }
        if instances.count == 1,
           let processes = instances.values.first {
            let mainProcesses = processes.filter(\.isMainApplicationProcess)
            if mainProcesses.count == 1, let main = mainProcesses.first {
                return main
            }
        }

        let guidance = fullPathWasProvided ? "use a PID" : "use a PID or full path"
        throw CUError(
            "ambiguous_target",
            "App identifier '\(identifier)' matches multiple running instances; \(guidance)"
        )
    }

    nonisolated static func selector(payload: JSONValue) throws -> AppTargetSelector? {
        if let rawPID = payload["pid"] {
            guard case .int(let value) = rawPID,
                  value > 0,
                  let pid = pid_t(exactly: value) else {
                throw CUError("bad_payload", "pid must be a positive 32-bit integer")
            }
            return .pid(pid)
        }

        if let rawBundleIdentifier = payload["bundleId"] {
            guard case .string(let value) = rawBundleIdentifier else {
                throw CUError("bad_payload", "bundleId must be a non-empty string")
            }
            let identifier = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !identifier.isEmpty else {
                throw CUError("bad_payload", "bundleId must be a non-empty string")
            }
            return .bundleIdentifier(identifier)
        }

        if let rawApp = payload["app"] {
            guard case .string(let value) = rawApp else {
                throw CUError("bad_payload", "app must be a non-empty string")
            }
            let identifier = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !identifier.isEmpty else {
                throw CUError("bad_payload", "app must be a non-empty string")
            }
            return .app(identifier)
        }

        return nil
    }

    nonisolated static func requiredSelector(payload: JSONValue) throws -> AppTargetSelector {
        guard let selector = try selector(payload: payload) else {
            throw CUError(
                "no_target",
                "Computer Use requires an explicit target app"
            )
        }
        return selector
    }

    nonisolated static func resolve(
        selector: AppTargetSelector?,
        candidates: [AppTargetCandidate]
    ) throws -> ResolvedAppTarget? {
        guard let selector else { return nil }

        switch selector {
        case .pid(let pid):
            guard let candidate = candidates.first(where: { $0.pid == pid }) else {
                throw CUError("target_not_running", "Target process \(pid) is not running")
            }
            return ResolvedAppTarget(
                pid: candidate.pid,
                bundleIdentifier: candidate.bundleIdentifier,
                bundleURL: candidate.bundleURL
            )
        case .bundleIdentifier(let identifier), .app(let identifier):
            do {
                return try match(identifier: identifier, candidates: candidates)
            } catch let error as CUError where error.code == "target_not_running" {
                return nil
            }
        }
    }

    /// Resolve a target for permission preflight without launching or activating
    /// anything. A running exact match wins. Name/bundle/path selectors may then
    /// resolve to one installed bundle; a PID can only ever identify a running
    /// process. Ambiguity is always an error.
    nonisolated static func resolveWithoutLaunching(
        selector: AppTargetSelector,
        runningCandidates: [AppTargetCandidate],
        installedCandidates: [InstalledAppTarget]
    ) throws -> UnlaunchedAppTarget {
        if let running = try resolve(
            selector: selector,
            candidates: runningCandidates
        ) {
            return .running(running)
        }

        if case .pid(let pid) = selector {
            throw CUError(
                "target_not_running",
                "Target process \(pid) is not running"
            )
        }

        let identifier: String
        switch selector {
        case .pid:
            fatalError("handled above")
        case .bundleIdentifier(let value), .app(let value):
            identifier = value
        }
        return .installed(try matchInstalled(
            identifier: identifier,
            candidates: installedCandidates
        ))
    }

    nonisolated static func matchInstalled(
        identifier raw: String,
        candidates: [InstalledAppTarget]
    ) throws -> InstalledAppTarget {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw CUError("no_target", "App identifier is empty")
        }
        let normalizedPath = value.hasPrefix("/")
            ? URL(fileURLWithPath: value).standardizedFileURL.path
            : nil
        let matches: [InstalledAppTarget]
        if let normalizedPath {
            matches = candidates.filter {
                $0.bundleURL.standardizedFileURL.path == normalizedPath
            }
        } else {
            let name = URL(fileURLWithPath: value)
                .deletingPathExtension()
                .lastPathComponent
            matches = candidates.filter { candidate in
                if candidate.bundleIdentifier.caseInsensitiveCompare(value) == .orderedSame {
                    return true
                }
                return [
                    candidate.displayName,
                    candidate.bundleURL.deletingPathExtension().lastPathComponent,
                ].contains { $0.caseInsensitiveCompare(name) == .orderedSame }
            }
        }
        guard matches.count == 1, let match = matches.first else {
            if matches.count > 1 {
                throw CUError(
                    "ambiguous_target",
                    "App identifier '\(raw)' matches multiple installed apps; use a bundle id or full path"
                )
            }
            throw CUError("app_not_found", "No installed app matches '\(raw)'")
        }
        return match
    }

    static func resolveRunning(payload: JSONValue) throws -> ResolvedAppTarget? {
        try resolve(selector: selector(payload: payload), candidates: candidates())
    }

    static func resolveRunning(selector: AppTargetSelector?) throws -> ResolvedAppTarget? {
        try resolve(selector: selector, candidates: candidates())
    }

    static func launch(identifier raw: String, activate: Bool) async -> ResolvedAppTarget? {
        let identifier = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !identifier.isEmpty else { return nil }

        let workspace = NSWorkspace.shared
        let appURL: URL?
        if identifier.hasPrefix("/") || identifier.hasSuffix(".app") {
            appURL = URL(fileURLWithPath: identifier)
        } else if let url = workspace.urlForApplication(withBundleIdentifier: identifier) {
            appURL = url
        } else if let path = workspace.fullPath(forApplication: identifier) {
            appURL = URL(fileURLWithPath: path)
        } else {
            appURL = nil
        }

        guard let appURL,
              let app = try? await workspace.openApplication(
                  at: appURL,
                  configuration: openConfiguration(activate: activate)
              ),
              app.processIdentifier > 0,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let bundleIdentifier = app.bundleIdentifier,
              !bundleIdentifier.isEmpty else {
            return nil
        }

        for _ in 0..<30 {
            if app.isFinishedLaunching { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }

        return ResolvedAppTarget(
            pid: app.processIdentifier,
            bundleIdentifier: bundleIdentifier,
            bundleURL: app.bundleURL?.standardizedFileURL ?? appURL.standardizedFileURL
        )
    }

    static func openConfiguration(activate: Bool) -> NSWorkspace.OpenConfiguration {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = activate
        configuration.createsNewApplicationInstance = false
        return configuration
    }
}
