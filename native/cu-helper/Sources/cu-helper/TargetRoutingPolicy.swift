import Foundation

enum TargetRoutingPolicy {
    static func pid(explicit: pid_t?, coordinateOwner _: pid_t?) throws -> pid_t {
        guard let explicit, explicit > 0 else {
            throw CUError("no_target", "Computer Use requires an explicit target app for this action")
        }
        return explicit
    }
}
