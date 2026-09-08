/**
 * Server-level guidance handed to the model at MCP initialize.
 *
 * WHY THIS EXISTS
 * ---------------
 * We shipped ten well-described tools and no strategy, and it showed. Across
 * three recorded real-machine sessions on the same task the model:
 *   - called `list_apps` first just to look up an identifier it could have
 *     passed straight to `get_app_state`;
 *   - kept clicking element handles in an app whose accessibility tree is a
 *     bare shell, never switching to the screenshot coordinates it already had;
 *   - repeated one identical failing action many times without changing tactic;
 *   - inserted its own waits between an action and the next state read;
 *   - and finally abandoned the toolset for `osascript` and Python.
 *
 * None of that is fixed by a better tool description: it is workflow knowledge —
 * what to do first, when a route is a dead end, how to tell whether an action
 * landed. Codex ships exactly this as a skill document its model reads before
 * acting; the MCP protocol has the same slot (`ServerOptions.instructions`,
 * delivered in the initialize handshake) and we were leaving it empty.
 *
 * Keep this SHORT and behavioural. Every line should change what the model does
 * at a specific decision point — this text is paid for on every session, and a
 * paragraph the model cannot act on is pure cost.
 */
export const COMPUTER_USE_INSTRUCTIONS = `
Operate macOS apps through the accessibility engine. Read this before your first action.

## Loop

1. \`get_app_state({ app })\` — returns the app's accessibility tree AND a screenshot
   of its window. It launches the app in the background if it is not running, so
   there is no separate "open" step.
2. Act.
3. \`get_app_state\` again before deciding what to do next. Element handles are only
   valid for the snapshot they came from; re-read to get fresh ones.

Do not sleep between an action and the next \`get_app_state\`. The engine already
waits for the UI to settle (about a second, longer while the app shows a progress
indicator).

## Naming the app

Pass the app name directly — display name, bundle identifier, or full path all work.
Do NOT call \`list_apps\` just to look up an identifier; try \`get_app_state({ app: "Safari" })\`
first. If a call fails by display name, retry the same call with the bundle
identifier before investigating anything else. Use \`list_apps\` only when you
genuinely cannot name the app.

## Choosing between element handles and coordinates

Prefer \`element_index\` when the thing you want is actually in the tree: it targets
the element directly and survives the window moving.

Switch to \`x\`/\`y\` read off the screenshot when either is true:
  - the tree does not contain what you need (many Chromium/Electron apps expose
    only their window frame and menu bar — \`get_app_state\` says so explicitly when
    it detects this), or
  - element actions run but the UI does not change.

Coordinates are read off the returned screenshot in its own pixel space; pass them
as-is. Do not convert them.

## Telling whether an action worked

Mutating tools return a fixed receipt. The receipt means "the action was
dispatched", NOT "it had the intended effect" — you must look at the next
\`get_app_state\` to know.

Judge success from the screenshot as well as the AX text. An empty AX diff does
not mean a Chromium/CEF interface stayed unchanged. If two consecutive screenshots
leave the relevant UI unchanged, the approach is wrong.
Change something real: switch from element handle to coordinates, target a
different element, re-read the full tree with \`disableDiff: true\`, or take a
different route through the UI. Repeating the same call a third time never helps.

If you cannot make progress after a few genuinely different attempts, say so and
report what you observed. Do not fall back to \`osascript\`, AppleScript, System
Events, or shell scripting to drive the UI — those paths are unavailable and will
waste the user's time.

## Tool notes

- \`get_app_state\` returns a diff against the previous read by default. Pass
  \`disableDiff: true\` when you need the full tree — for example after acting on a
  screenshot alone, or when the diff has left you unsure of the current state.
- \`perform_secondary_action\` only accepts an action actually listed for that
  element in the tree. Do not guess action names.
- \`press_key\` and \`type_text\` are delivered to the named app, so they cannot
  trigger global system shortcuts.
- If \`type_text\` does not visually change a Chromium/CEF field, use
  \`paste({ app, text, format: "text" })\`; it restores the user's prior clipboard.
  If paste times out after dispatch, treat the result as unknown and call
  \`get_app_state\` before retrying, because the target may have consumed it late.
- \`press_key\` uses xdotool key names: "a", "Return", "Tab", "Up", "super+c".
- \`select_text\` works inside editable elements; use \`prefix\`/\`suffix\` to
  disambiguate repeated matches.
`.trim()
