import Foundation

/// Allocates a complete synthetic-event sequence before the first event is
/// posted. This prevents a partial gesture (for example mouse-down without its
/// matching mouse-up) when a later allocation fails.
enum EventBurst {
    static func allocateAll<Spec, Event>(
        specs: [Spec],
        allocate: (Spec) throws -> Event?
    ) throws -> [Event] {
        var events: [Event] = []
        events.reserveCapacity(specs.count)
        for spec in specs {
            guard let event = try allocate(spec) else {
                throw CUError(
                    "event_alloc",
                    "Failed to allocate complete synthetic event sequence"
                )
            }
            events.append(event)
        }
        return events
    }

    static func perform<Spec, Event>(
        specs: [Spec],
        allocate: (Spec) throws -> Event?,
        post: (Event) -> Void
    ) throws {
        let events = try allocateAll(specs: specs, allocate: allocate)
        for event in events {
            post(event)
        }
    }
}
