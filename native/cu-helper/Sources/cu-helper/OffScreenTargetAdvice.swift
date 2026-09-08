import Foundation

/// Told to the model when the app it is looking at cannot be acted on.
///
/// Window capture and window actuation disagree about what "exists": the
/// screenshot path deliberately includes off-screen windows
/// (`onScreenWindowsOnly: false`), while every actuation path needs an
/// on-screen window to name. A minimized target therefore produced a perfectly
/// real screenshot that no click could ever reach — and, before
/// `requireBindableWindow`, each of those clicks still came back "Action
/// completed". A whole session was spent clicking and typing into a window that
/// was in the Dock.
///
/// The refusal alone is not enough. Without this notice the model only learns
/// the target is unreachable by trying, one failed action at a time, and its
/// natural reading of "that click did nothing" is to try different
/// coordinates — which cannot work either.
///
/// The notice must be precise about WHICH half is blocked. Only coordinate
/// actuation needs on-screen geometry, because only it hit-tests. Element
/// actions address a node directly and work on a window in the Dock, which is
/// exactly how an app gets driven while the user has the screen to themselves —
/// the capability this whole feature exists for. Saying "nothing works here"
/// would be simpler, and would switch that capability off.
enum OffScreenTargetAdvice {
    static let notice = """
    NOTE: This app has no window on screen right now — it is minimized, hidden, \
    or on another Space. The accessibility tree and screenshot above are real, \
    but every x/y action is refused while it stays this way, and no choice of \
    coordinates will change that: a window with no on-screen geometry cannot be \
    hit-tested. Do not retry with different coordinates.

    Element actions still work. `element_index` clicks, `set_value`, \
    `select_text` and `perform_secondary_action` address the element directly \
    and need no on-screen geometry, so an app with a real accessibility tree \
    can be driven exactly like this while it is off screen. Use them.

    If the tree is a bare shell — window frame and menu bar only, as Chromium \
    and Electron apps report — then there are no elements to address and \
    nothing here can work. Say so, name the app, and ask the user to bring it \
    back on screen.
    """

    /// - Parameter hasWindowOnScreen: whether the target owns an ordinary
    ///   on-screen window at the moment the state was captured.
    static func noticeIfUnreachable(hasWindowOnScreen: Bool) -> String? {
        hasWindowOnScreen ? nil : notice
    }
}
