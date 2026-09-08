import CoreGraphics
import Foundation

/// One fully rendered AX line paired with its stable element ID. Diffing uses
/// the typed ID, never the model-visible `g<epoch>:<id>` prefix in `rendered`.
struct AXTreeDiffLine: Equatable, Sendable {
    let id: Int
    let rendered: String
}

/// An ID plus an immutable locator key. The ID is stable for `previous` rows
/// and provisional for `current` rows passed to ``AXTreeDiff.reconcile``.
struct AXTreeIdentity<Key: Hashable>: Hashable {
    let id: Int
    let key: Key
}

/// Stable display evidence for an emitted AX line that is not safe to refetch
/// for actions. Raw topology and immutable semantics may preserve its display ID
/// across identical refreshes without upgrading it into an actionable locator.
struct AXTreeDisplayIdentity<Root: Hashable, Fingerprint: Hashable>: Hashable {
    let root: Root
    let rawPath: [Int]
    let fingerprint: Fingerprint
    let role: String
    let title: String?
    let depth: Int
}

/// Reconciliation identity and action safety are deliberately orthogonal.
/// Display-only rows may receive stable IDs for clean diffs, but callers can
/// never use that stability as evidence that the row is safe to refetch.
enum AXTreeStableIdentity<ActionKey: Hashable, DisplayKey: Hashable>: Hashable {
    case actionable(ActionKey)
    case displayOnly(DisplayKey)
    /// A display row whose root has no immutable continuity evidence. It may be
    /// rendered and diffed, but its ID must be newly allocated on every refresh.
    case transientDisplay(DisplayKey)

    var isActionRefetchable: Bool {
        guard case .actionable = self else { return false }
        return true
    }

    var canInheritStableID: Bool {
        guard case .transientDisplay = self else { return true }
        return false
    }
}

struct AXTreeIDReconciliation: Equatable, Sendable {
    /// Current provisional ID -> stable ID in the active window epoch.
    let assignments: [Int: Int]
    /// The first never-issued stable ID for the next refresh.
    let nextID: Int

    func containsStableID(_ id: Int) -> Bool {
        assignments.values.contains(id)
    }
}

enum AXTreeReconciliationError: Error, Equatable {
    case invalidNextID
    case duplicatePreviousID(Int)
    case duplicateCurrentID(Int)
    case stableIDExhausted
    case incompleteAssignments
}

enum AXTreeDiffError: Error, Equatable {
    case duplicateOldLineID(Int)
    case duplicateNewLineID(Int)
}

struct AXTreeDiffResult: Equatable, Sendable {
    let markedLines: [String]
    let removedIDs: [Int]

    var isEmpty: Bool {
        markedLines.isEmpty && removedIDs.isEmpty
    }
}

struct AXTreeRefreshPolicy: Equatable, Sendable {
    let reuseEpoch: Bool
    let returnFull: Bool
}

/// Process-lifetime evidence prevents a recycled pid/window number from
/// inheriting an earlier application's epoch inside the long-lived daemon.
struct AXTreeProcessIdentity: Equatable, Sendable {
    let bundleID: String?
    let executablePath: String?
    let launchTime: TimeInterval?

    var isProven: Bool {
        guard let bundleID, !bundleID.isEmpty,
              let executablePath, !executablePath.isEmpty,
              launchTime != nil else { return false }
        return true
    }
}

/// Process and key-window evidence bound to one published AX snapshot.
struct AXTreeSnapshotEvidence: Equatable, Sendable {
    let processIdentity: AXTreeProcessIdentity
    let keyWindowID: CGWindowID?
}

/// Pure view of the current AXTree session used by the router's coarse handle
/// guard. Exact epoch plus sparse dictionary membership are both required.
struct AXTreeHandleMembership: Equatable, Sendable {
    let snapshotID: UInt64
    let processIdentity: AXTreeProcessIdentity
    let elementIDs: Set<Int>

    func matchesCurrentProcess(_ current: AXTreeProcessIdentity?) -> Bool {
        processIdentity.isProven
            && current?.isProven == true
            && current == processIdentity
    }

    func contains(
        _ handle: SnapshotElementHandle,
        currentProcessIdentity: AXTreeProcessIdentity?
    ) -> Bool {
        matchesCurrentProcess(currentProcessIdentity)
            && handle.snapshotID == snapshotID
            && elementIDs.contains(handle.index)
    }
}

enum AXTreeDiff {
    /// Inherit an ID only when an immutable locator occurs exactly once in both
    /// revisions. Ambiguous duplicates (notably synthetic lines sharing a live
    /// row locator) all receive new IDs. `nextID` only increases, so removed IDs
    /// are never reused within an epoch.
    static func reconcile<Key: Hashable>(
        previous: [AXTreeIdentity<Key>],
        current: [AXTreeIdentity<Key>],
        nextID: Int,
        canInherit: (Key) -> Bool = { _ in true }
    ) throws -> AXTreeIDReconciliation {
        guard nextID >= 0 else {
            throw AXTreeReconciliationError.invalidNextID
        }
        var previousIDs = Set<Int>()
        for item in previous {
            guard previousIDs.insert(item.id).inserted else {
                throw AXTreeReconciliationError.duplicatePreviousID(item.id)
            }
        }
        if let previousMax = previousIDs.max(), previousMax >= nextID {
            throw AXTreeReconciliationError.invalidNextID
        }
        var currentIDs = Set<Int>()
        for item in current {
            guard currentIDs.insert(item.id).inserted else {
                throw AXTreeReconciliationError.duplicateCurrentID(item.id)
            }
        }

        var previousByKey: [Key: [Int]] = [:]
        for item in previous {
            previousByKey[item.key, default: []].append(item.id)
        }

        var currentCountByKey: [Key: Int] = [:]
        for item in current {
            currentCountByKey[item.key, default: 0] += 1
        }

        var cursor = nextID
        var assignments: [Int: Int] = [:]
        assignments.reserveCapacity(current.count)
        for item in current {
            if canInherit(item.key),
               previousByKey[item.key]?.count == 1,
               currentCountByKey[item.key] == 1,
               let inherited = previousByKey[item.key]?.first {
                assignments[item.id] = inherited
            } else {
                assignments[item.id] = cursor
                guard let incremented = incrementStableID(cursor) else {
                    throw AXTreeReconciliationError.stableIDExhausted
                }
                cursor = incremented
            }
        }
        guard assignments.count == current.count else {
            throw AXTreeReconciliationError.incompleteAssignments
        }
        return AXTreeIDReconciliation(assignments: assignments, nextID: cursor)
    }

    static func incrementStableID(_ id: Int) -> Int? {
        guard id >= 0 else { return nil }
        let (incremented, overflow) = id.addingReportingOverflow(1)
        return overflow ? nil : incremented
    }

    static func shouldWarmAX(
        cached: AXTreeProcessIdentity?,
        current: AXTreeProcessIdentity
    ) -> Bool {
        !current.isProven || cached != current
    }

    static func render(
        old: [AXTreeDiffLine],
        new: [AXTreeDiffLine]
    ) throws -> AXTreeDiffResult {
        var oldByID: [Int: String] = [:]
        oldByID.reserveCapacity(old.count)
        for line in old {
            guard oldByID.updateValue(line.rendered, forKey: line.id) == nil else {
                throw AXTreeDiffError.duplicateOldLineID(line.id)
            }
        }

        var newIDs = Set<Int>()
        newIDs.reserveCapacity(new.count)
        for line in new {
            guard newIDs.insert(line.id).inserted else {
                throw AXTreeDiffError.duplicateNewLineID(line.id)
            }
        }

        let markedLines = new.compactMap { line -> String? in
            guard let oldRendered = oldByID[line.id] else {
                return "+\(line.rendered)"
            }
            guard oldRendered != line.rendered else { return nil }
            return "~\(line.rendered)"
        }
        let removedIDs = old.map(\.id).filter { !newIDs.contains($0) }.sorted()
        return AXTreeDiffResult(markedLines: markedLines, removedIDs: removedIDs)
    }

    static func removedIDSummary(_ ids: [Int]) -> String? {
        let sorted = Array(Set(ids)).sorted()
        guard let first = sorted.first else { return nil }

        var ranges: [String] = []
        var start = first
        var end = first
        for id in sorted.dropFirst() {
            let (successor, overflow) = end.addingReportingOverflow(1)
            if !overflow, id == successor {
                end = id
                continue
            }
            ranges.append(start == end ? "\(start)" : "\(start)-\(end)")
            start = id
            end = id
        }
        ranges.append(start == end ? "\(start)" : "\(start)-\(end)")
        return "Removed element IDs: \(ranges.joined(separator: ", "))"
    }

    static func text(
        old: [AXTreeDiffLine],
        new: [AXTreeDiffLine],
        windowTitle: String,
        contextTail: [String]
    ) throws -> String {
        let difference = try render(old: old, new: new)
        var lines: [String]
        if difference.isEmpty {
            lines = [
                "There has been no change in the accessibility tree for Window: \"\(windowTitle)\"."
            ]
        } else {
            lines = [
                "The following is a diff from the previous accessibility tree for Window: \"\(windowTitle)\" with ~ and + representing changed and added elements, respectively. Removed elements are summarized by ID range."
            ]
            if let removed = removedIDSummary(difference.removedIDs) {
                lines.append(removed)
            }
            lines.append(contentsOf: difference.markedLines)
        }
        lines.append(contentsOf: contextTail)
        return lines.joined(separator: "\n")
    }

    /// An epoch can be reused only for the same proven process lifetime and key
    /// window. Full-vs-diff never skips rebuilding the complete AX tree.
    static func refreshPolicy(
        previousProcessIdentity: AXTreeProcessIdentity?,
        currentProcessIdentity: AXTreeProcessIdentity?,
        previousWindowID: UInt32?,
        currentWindowID: UInt32?,
        hasBaseline: Bool,
        disableDiff: Bool
    ) -> AXTreeRefreshPolicy {
        let sameProvenProcess = currentProcessIdentity?.isProven == true
            && previousProcessIdentity == currentProcessIdentity
        let reuseEpoch = sameProvenProcess
            && previousWindowID != nil
            && currentWindowID != nil
            && previousWindowID == currentWindowID
        return AXTreeRefreshPolicy(
            reuseEpoch: reuseEpoch,
            returnFull: disableDiff || !hasBaseline || !reuseEpoch
        )
    }
}
