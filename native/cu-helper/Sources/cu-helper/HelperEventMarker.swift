import CoreGraphics

/// One fixed nonzero marker inherited by every event created from a helper
/// source. The listen-only input monitor excludes events carrying this value.
enum HelperEventMarker {
    static let value: Int64 = 0x4343_4841_4841_4355

    @discardableResult
    static func mark(_ source: CGEventSource?) -> CGEventSource? {
        source?.userData = value
        return source
    }
}
