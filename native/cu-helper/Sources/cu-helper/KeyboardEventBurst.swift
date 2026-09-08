import CoreGraphics

/// Allocates a complete PID-targeted keyboard burst before caller-supplied posting.
/// Modifier state is communicated with flagsChanged, not synthetic modifier-key
/// presses. Allocation uses an explicit source and modifier baseline; production
/// dispatch captures that baseline independently without changing physical input.
enum KeyboardEventBurst {
    enum Specification {
        case flagsChanged(CGEventFlags)
        case keyDown(CGKeyCode, CGEventFlags)
        case keyUp(CGKeyCode, CGEventFlags)
    }

    /// Match the reference keyboard source lifetime and state domain. HID is
    /// the source state only; the caller still posts exclusively to its PID.
    @MainActor
    static func makeSource() throws -> CGEventSource {
        guard let source = HelperEventMarker.mark(CGEventSource(stateID: .hidSystemState)) else {
            throw CUError(CUError.Code.eventAlloc, "Failed to allocate a keyboard event source")
        }
        return source
    }

    /// A key command owns a fresh source. Restore physical modifiers from the
    /// independent combined-session domain, after focus preparation completes.
    @MainActor
    static func dispatch(
        chords: [KeyMapping.Chord],
        prepare: @MainActor () async throws -> Void,
        makeSource: @MainActor () throws -> CGEventSource = { try KeyboardEventBurst.makeSource() },
        readFlagsState: @MainActor (CGEventSourceStateID) -> CGEventFlags = { CGEventSource.flagsState($0) },
        validateBeforePosting: @MainActor () throws -> Void,
        post: @MainActor (CGEvent) -> Void
    ) async throws {
        try Task.checkCancellation()
        let source = try makeSource()
        try await dispatch(
            chords: chords, source: source, prepare: prepare,
            restoringFlags: { readFlagsState(.combinedSessionState) },
            validateBeforePosting: validateBeforePosting, post: post
        )
    }

    /// Prepare may yield while target focus is established. Validate the
    /// caller's clipboard lease only after that wait and allocation, then keep
    /// validation and the complete burst in the same main-actor turn.
    @MainActor
    static func dispatch(
        chords: [KeyMapping.Chord],
        source: CGEventSource,
        prepare: @MainActor () async throws -> Void,
        restoringFlags: @MainActor () -> CGEventFlags,
        validateBeforePosting: @MainActor () throws -> Void,
        post: @MainActor (CGEvent) -> Void
    ) async throws {
        try Task.checkCancellation()
        try await prepare()
        let events = try allocate(chords: chords, source: source, restoringFlags: restoringFlags())
        try Task.checkCancellation()
        try validateBeforePosting()
        for event in events { post(event) }
    }

    static func allocate(
        chords: [KeyMapping.Chord],
        source: CGEventSource,
        restoringFlags: CGEventFlags,
        allocateEvent: (Specification, CGEventSource) throws -> CGEvent? = {
            makeEvent($0, source: $1)
        }
    ) throws -> [CGEvent] {
        let specs: [Specification] = chords.flatMap { chord in
            [
                .flagsChanged(chord.flags),
                .keyDown(chord.keyCode, chord.flags),
                // Restore the captured baseline before key-up. The key-up
                // itself retains its chord flags, matching the key-down.
                .flagsChanged(restoringFlags),
                .keyUp(chord.keyCode, chord.flags),
            ]
        }

        return try EventBurst.allocateAll(specs: specs) { spec in
            try allocateEvent(spec, source)
        }
    }

    static func makeEvent(_ spec: Specification, source: CGEventSource) -> CGEvent? {
        let event: CGEvent?
        let flags: CGEventFlags
        switch spec {
        case let .flagsChanged(value):
            event = CGEvent(source: source)
            event?.type = .flagsChanged
            flags = value
        case let .keyDown(keyCode, value):
            event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
            flags = value
        case let .keyUp(keyCode, value):
            event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
            flags = value
        }
        event?.flags = flags
        return event
    }
}
