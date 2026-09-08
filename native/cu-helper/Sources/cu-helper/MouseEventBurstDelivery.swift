import CoreGraphics

/// Delivers an already allocated mouse gesture. An optional pause lets drags
/// process lifecycle work; ordinary clicks stay in one main-actor turn without
/// yielding between their down/up pairs. Cancellation stops further input; only an outstanding down
/// may be released, at the last point actually delivered rather than the end of
/// an unfinished drag. The caller must validate identity again inside release.
@MainActor
enum MouseEventBurstDelivery {
    static func deliver(
        events: [CGEvent],
        validate: @MainActor () throws -> Void,
        post: @MainActor (CGEvent) -> Void,
        release: @MainActor (CGEvent, CGPoint) throws -> Void,
        pause: (@MainActor () async throws -> Void)? = nil
    ) async throws {
        var heldDown: CGEvent?
        var lastPoint = CGPoint.zero

        do {
            for event in events {
                try Task.checkCancellation()
                try validate()
                try Task.checkCancellation()
                post(event)
                lastPoint = event.location
                switch event.type {
                case .leftMouseDown, .rightMouseDown, .otherMouseDown:
                    heldDown = event
                case .leftMouseUp where heldDown?.type == .leftMouseDown,
                     .rightMouseUp where heldDown?.type == .rightMouseDown,
                     .otherMouseUp where heldDown?.type == .otherMouseDown:
                    heldDown = nil
                default:
                    break
                }
                if let pause { try await pause() }
                // A caller's pause may return normally despite cancellation.
                // This check also covers cancellation after the final mouse-up.
                try Task.checkCancellation()
            }
        } catch {
            if let heldDown {
                // Cleanup failure must not hide the original interruption or
                // restart the gesture. The caller owns safe release routing.
                try? release(heldDown, lastPoint)
            }
            throw error
        }
    }
}
