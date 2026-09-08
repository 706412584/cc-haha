# `cu-helper` — Integration Guide

A native Swift Computer Use helper for claude-code-haha. It replaces the
`runtime/mac_helper.py` (pyautogui + mss) bridge with a single, code-signed
`arm64` executable that:

- **never moves the real OS cursor** — every mouse/keyboard event is posted to a
  *specific* application process via `CGEvent.postToPid(...)`, and the on-screen
  motion the user sees is a **virtual cursor overlay** we draw ourselves;
- **animates** that virtual cursor (ease-out-cubic glide, ~2000 px/s capped at
  0.5 s) and paints a **glowing capture overlay** around the app the AI is
  driving — both of which need a persistent main-thread run loop;
- keeps **stdout clean** so the existing Node bridge can `JSON.parse` exactly one
  line per command.

> **Status of this document.** This file *describes* the integration. It does
> **not** apply any TypeScript or Tauri change. Section 3 lists, verbatim, the
> files that *would* change and how — nothing here edits them. The Swift package
> itself is self-contained and builds/links independently (see
> [`build.sh`](./build.sh)).

> **TCC honesty.** Real cross-app clicking/typing requires **Accessibility** and
> real screen capture requires **Screen Recording**, both granted *to this
> binary* by the user in **System Settings ▸ Privacy & Security**. A CI job or a
> background agent **cannot** grant these. Everything in §6.1–§6.4 is verifiable
> without any TCC grant; everything that touches another app's input or the
> framebuffer is a **manual** checklist in §6.5.

---

## 1. Dual-mode invocation

The binary is **one executable, two modes**. This is forced by two facts that
pull in opposite directions:

1. **The existing bridge is per-command.** `src/utils/computerUse/pythonBridge.ts`
   (`callPythonHelper`, lines 159–183 — **MUST NOT be edited**) spawns
   `<helper> <command> --payload '<json>'`, reads exactly **one** stdout line
   `{ok, result?, error?}`, and the process exits. Tolerant of a nonzero exit
   code **only when stdout is empty** (`if (code !== 0 && !stdout.trim())`).

2. **The overlays are inherently stateful.** `CADisplayLink`/`CABasicAnimation`
   only tick while a live `CFRunLoop` runs on the main thread, and the *virtual*
   cursor's logical position (the source of truth for `cursor_position`, for
   `drag` with an implicit `from`, and for decomposed `mouse_down`/`mouse_up`)
   must survive *between* commands. A one-shot process that writes a line and
   dies cannot animate anything and remembers nothing.

So the **daemon** holds everything stateful/visual and the **CLI** degrades
gracefully:

### 1a. CLI one-shot — `cu-helper <command> --payload '<json>'`

Runs against the **unchanged** bridge **today**, for **every** command. Builds a
`CommandRouter` with a **headless** `VirtualCursor` (no `NSWindow`, no
animation), dispatches the single command, prints **exactly one**
`{"ok":...}\n` line, and `exit(0)`.

- **Fully correct in CLI mode** (no run loop, no shared state needed): `displays`
  (`get_display_size`, `list_displays`, `find_window_displays`), `screenshot`,
  `zoom`, `resolve_prepare_capture`, all keyboard ops (`key`, `hold_key`,
  `type`), `click`, `scroll`, clipboard (`read_clipboard`, `write_clipboard`,
  `paste_clipboard`), app queries (`frontmost_app`, `app_under_point`,
  `list_installed_apps`, `list_running_apps`, `open_app`), and
  `check_permissions`.
- **Degraded in CLI mode** (cursor-stateful): `move_mouse`/`drag` post events
  **instantly** (no glide); `cursor_position` reads a best-effort disk-persisted
  point at `~/.claude/.runtime/cu-helper.cursor.json` and `move_mouse` writes it;
  `mouse_down`/`mouse_up` post immediately. A half-finished drag **cannot** span
  two one-shot processes — documented limitation.
- **On *any* thrown error**, CLI mode prints `{"ok":false,"error":{"message":...}}`
  and **still `exit(0)`** (never nonzero — we always emit JSON, and a nonzero
  code with JSON on stdout would be misread by the bridge's empty-stdout branch).
- Critically, CLI mode writes its one line and exits **before** AppKit spins up
  any window, so os_log/CoreGraphics chatter never reaches stdout.

```bash
cu-helper list_displays           --payload '{}'
cu-helper screenshot              --payload '{"targetWidth":1280,"targetHeight":800,"jpegQuality":0.75}'
cu-helper click                   --payload '{"x":640,"y":400,"button":"left","count":1,"modifiers":[]}'
cu-helper type                    --payload '{"text":"héllo 世界"}'
cu-helper check_permissions       --payload '{}'
```

### 1b. Daemon — `cu-helper daemon --socket <path>`

Long-lived. The primary engine. `NSApplication.shared` with
`.setActivationPolicy(.accessory)` (no Dock icon, never steals focus, but *can*
own windows), and `app.run()` drives the single main-thread run loop. It:

- creates the `VirtualCursorOverlay` window(s) and `CaptureGlowOverlay`
  window(s) **once** and keeps them warm (hidden between turns);
- reads NDJSON request lines off an `AF_UNIX` `SOCK_STREAM` socket on a
  background `DispatchQueue`, marshals each decoded (`Sendable`) request onto
  `@MainActor` (`Task { @MainActor in router.handle(...) }`), then writes the
  `{ok,...}` response line back on the IO queue;
- holds the virtual cursor's logical position, the held mouse button, and held
  keys **in memory** as the single source of truth.

**Why a UNIX socket, not stdio.** A GUI/AppKit process leaks os_log and
CoreGraphics warnings to stdout/stderr, which would corrupt the bridge's
`JSON.parse`. The daemon therefore reserves **stdout for exactly one readiness
line** and serves the request/response stream over the private socket.

### 1c. How the two modes relate to the file lock (orthogonal)

The per-session file lock (`~/.claude/computer-use.lock`,
`src/utils/computerUse/computerUseLock.ts`) decides **which Node session** may
use Computer Use. The daemon is *that session's* execution engine. The two are
independent: the lock is a session mutex; the daemon is a rendering+injection
process. If the daemon dies mid-session, the bridge falls back to per-command
CLI spawns (§1a) and respawns the daemon on the next fresh lock acquisition.

**v1 deliberately skips** lock-screen autonomy, auto-unlock, and any guardian
process.

---

## 2. NDJSON socket protocol (daemon mode)

Transport: `AF_UNIX` / `SOCK_STREAM` at the `--socket` path (default
`~/.claude/.runtime/cu-helper.<pid>.sock`; the runtime dir is
`getClaudeConfigHomeDir()` + `/.runtime`, created with `mkdir -p`). Framing:
**one JSON object + `'\n'` per message**, both directions (NDJSON).

### 2a. Readiness line (stdout, exactly once)

Immediately after the socket is bound + listening, the daemon writes **one**
line to **stdout** and nothing else ever again:

```json
{"ready":true,"pid":12345,"proto":1}
```

The caller awaits this line (with a timeout) **before** connecting to the
socket, which avoids a connect race against `bind()`/`listen()`.

### 2b. Request

```json
{"id":"<opaque string>","cmd":"<command>","payload":{ ... }}
```

- `id` — optional; echoed back verbatim for response matching.
- `cmd` — any command from the table below (the same set the CLI accepts) **or**
  a daemon-only control verb (§2d).
- `payload` — the command payload object (same shape the CLI passes after
  `--payload`).

### 2c. Response

```json
{"id":"<echoed>","ok":true,"result":<value>}
{"id":"<echoed>","ok":false,"error":{"message":"...","code":"<canonical>"}}
```

`result` is the command's result value (object, array, string, boolean, or
`{x,y}` — see §4). `error.code` is one of the canonical codes from `CUError`:
`no_target`, `not_trusted`, `screen_recording_denied`, `display_not_found`,
`window_not_found`, `event_alloc`, `unknown_key`, `secure_input`, `bad_payload`,
`bad_command`, `capture_failed`, `encode_failed`.

> **Envelope parity.** The CLI's single stdout line and the daemon's per-request
> response carry the **same** `{ok, result?, error?}` semantics, so the TS layer
> unwraps both identically (`parsed.ok ? parsed.result : throw error.message`).
> The only wire difference is the daemon's extra `id` field for multiplexing.

### 2d. Control verbs (daemon-only — never reach `CommandRouter`)

| Verb           | Effect                                                                                  | `result` |
|----------------|-----------------------------------------------------------------------------------------|----------|
| `overlay_show` | `cursor.show()` + `glow.show(over: frontmost app)`. Reveals the virtual cursor + glow.  | `true`   |
| `overlay_hide` | Parks the cursor and resets turn-owned AX/input/focus state. The keyed `SCStream` remains warm until target/config change, disconnect, or daemon teardown. | `true`   |
| `ping`         | Liveness probe.                                                                         | `"pong"` |
| `shutdown`     | Returns `true`, then `NSApp.terminate(nil)` for a graceful exit.                        | `true`   |

These verbs are **not** reachable via the CLI (a one-shot process has no overlay
and no run loop to host one). Every other `cmd` is routed through the shared
`CommandRouter` — the identical dispatcher the CLI uses — so each command has
**exactly one** implementation.

### 2e. Connection lifecycle

- One client connection at a time is expected (one Node session holds the CU
  lock). On client **disconnect**: hide the overlay, keep the daemon running
  idle (warm overlays preserved).
- On `shutdown`: terminate the `NSApplication`.

### 2f. Minimal client transcript

```text
# 1. spawn
$ cu-helper daemon --socket /tmp/cu.sock
{"ready":true,"pid":12345,"proto":1}        # <- the ONE stdout line

# 2. connect to /tmp/cu.sock, then write NDJSON requests:
--> {"id":"1","cmd":"ping"}
<-- {"id":"1","ok":true,"result":"pong"}

--> {"id":"2","cmd":"overlay_show"}
<-- {"id":"2","ok":true,"result":true}      # virtual cursor + glow appear; REAL mouse unmoved

--> {"id":"3","cmd":"move_mouse","payload":{"x":900,"y":500}}
<-- {"id":"3","ok":true,"result":true}      # overlay GLIDES; REAL mouse stays free

--> {"id":"4","cmd":"cursor_position"}
<-- {"id":"4","ok":true,"result":{"x":900,"y":500}}

--> {"id":"5","cmd":"shutdown"}
<-- {"id":"5","ok":true,"result":true}      # then the process exits
```

---

## 3. Proposed TypeScript / Tauri changes (described, **NOT applied**)

The Swift package ships independently. To wire it into the app, the following
changes would be made. **None of them are in this commit.** The guiding
constraint is that `pythonBridge.ts` (the per-command primitive) stays
**untouched** so the CLI fallback path remains byte-for-byte the behavior the
bridge already expects.

### 3.1 New file — `src/utils/computerUse/daemonClient.ts`

A new module owning the daemon lifecycle and the socket client. Proposed
surface:

```ts
// All paths under ~/.claude/.runtime (getClaudeConfigHomeDir() + '/.runtime').
export async function ensureDaemon(): Promise<void>
//   - resolve the cu-helper binary path (see §3.2);
//   - spawn `cu-helper daemon --socket <runtimeDir>/cu-helper.<pid>.sock`;
//   - await the single readiness line `{"ready":true,...}` with a timeout;
//   - connect the AF_UNIX socket; memoize the connection for the session.
//   - idempotent + self-healing: if a prior daemon died, respawn.

export async function callDaemon<T>(cmd: string, payload?: unknown): Promise<T>
//   - write one NDJSON request line with a fresh `id`;
//   - resolve with `result` on `{ok:true}`, reject with `error.message` on `{ok:false}`;
//   - on socket error / daemon-dead: fall back to a one-shot CLI spawn
//     (`cu-helper <cmd> --payload ...`) so the turn still completes.

export async function overlayShow(): Promise<void>   // callDaemon('overlay_show')
export async function overlayHide(): Promise<void>    // callDaemon('overlay_hide') — best-effort
export async function shutdownDaemon(): Promise<void> // callDaemon('shutdown') — best-effort, then forget connection
```

`callDaemon`'s fallback-to-CLI is what makes the daemon an *optimization*, not a
hard dependency: a dead daemon degrades to exactly the current per-command
behavior.

### 3.2 `src/utils/computerUse/executor.ts` — binary selection

Today the executor talks to Python via `callPythonHelper` (which reads
`helperFileName`/`helperPath` from `pythonBridge.ts`). The proposed change points
the executor at the **`cu-helper` binary** instead — for **stateful** ops it
calls `callDaemon(...)` (animated cursor, persistent state), and it keeps a
**CLI/one-shot** path for the rest. The unit of change is the *helper command
invocation*, swapping the Python interpreter + `mac_helper.py` for the signed
`cu-helper` binary resolved from:

- **dev:** `native/cu-helper/.build/release/cu-helper`;
- **bundled (Tauri):** the sidecar resolved from `binaries/cu-helper` (§3.5).

`pythonBridge.ts` is **not** edited; the Windows path (`win_helper.py`) is
untouched (this helper is macOS-only — `Package.swift` targets `.macOS("14.4")`).

### 3.3 `src/utils/computerUse/wrapper.tsx` — `acquireCuLock` fresh branch

`wrapper.tsx` builds the per-call `ComputerUseSessionContext`. Its
`acquireCuLock` callback (currently lines ~209–228) already detects the **fresh**
acquisition (`tryAcquireComputerUseLock()` → `{kind:'acquired', fresh:true}`) and
fires the Esc-hotkey registration + the "Claude is using your computer"
notification. The proposed addition, **inside that same `r.fresh` branch**:

```ts
if (r.fresh) {
  // ...existing escHotkey + sendOSNotification...
  await ensureDaemon()     // spawn + await readiness (best-effort; CLI fallback if it fails)
  await overlayShow()      // reveal virtual cursor + glowing capture overlay
}
```

This is the only place the daemon is started, and it happens **after** the
session wins the lock — so at most one daemon-owning session exists at a time.

### 3.4 `src/utils/computerUse/cleanup.ts` — `overlay_hide` + `shutdown`

`cleanupComputerUseAfterTurn` runs at natural turn end and on abort, and already
gates on `isLockHeldLocally()` before releasing the lock. Proposed additions:

- **at turn end (best-effort):** `await overlayHide().catch(() => {})` — hide the
  cursor and fade the glow between turns, before releasing the lock. The daemon
  stays warm.
- **on session archive / stop:** `await shutdownDaemon().catch(() => {})` —
  terminate the daemon process. (Session-archive cleanup site, not every turn.)

Both are best-effort and never block lock release: a hung `overlayHide` must not
wedge an abort, mirroring the existing `UNHIDE_TIMEOUT_MS` guard.

### 3.5 `desktop/src-tauri/tauri.conf.json` — `externalBin`

Add the signed binary as a Tauri sidecar alongside the existing one:

```jsonc
"externalBin": [
  "binaries/claude-sidecar",
  "binaries/cu-helper"          // <- added
]
```

Tauri resolves `externalBin` entries with a target-triple suffix
(`binaries/cu-helper-aarch64-apple-darwin`); `build.sh`'s output binary is copied
to that location by the desktop packaging step. The binary must already be
**code-signed with the stable identity** (§4) *before* Tauri bundles it, so the
app's notarized package preserves the TCC-stable signature.

---

## 4. Command contract & result shapes

Same dispatch table for CLI and daemon (`CommandRouter.handle(cmd:payload:)`).
Result shapes match `src/vendor/computer-use-mcp/executor.ts` and how
`src/utils/computerUse/executor.ts` normalizes them. **Coordinates are logical
top-left points already scaled by the TS layer — used verbatim; never
re-multiply by `scaleFactor`.**

| `cmd` | Payload | `result` | TCC needed |
|-------|---------|----------|------------|
| `prepare_for_action` | `{}` | `[]` (v1) | — |
| `preview_hide_set` | `{}` | `[]` (v1) | — |
| `get_display_size` | `{displayId?}` | `DisplayGeometry` (primary if `displayId` null) | none |
| `list_displays` | `{}` | `DisplayGeometry[]` | none |
| `find_window_displays` | `{bundleIds:[…]}` | `[{bundleId, displayIds:[…]}]` | none |
| `resolve_prepare_capture` | `{preferredDisplayId?, targetWidth, targetHeight, jpegQuality}` | `ResolvePrepareCaptureResult` | **Screen Recording** |
| `screenshot` | `{displayId?, targetWidth, targetHeight, jpegQuality}` | `ScreenshotResult` | **Screen Recording** |
| `zoom` | `{x, y, width, height, targetWidth, targetHeight}` | `{base64, width, height}` | **Screen Recording** |
| `key` | `{keySequence:"cmd+shift+a", repeat}` | `true` | **Accessibility** |
| `hold_key` | `{keyNames:[…], durationMs}` | `true` | **Accessibility** |
| `type` | `{text}` | `true` | **Accessibility** |
| `paste_clipboard` | `{}` | `true` | **Accessibility** |
| `read_clipboard` | `{}` | `string` | none |
| `write_clipboard` | `{text}` | `true` | none |
| `click` | `{x, y, button, count, modifiers}` | `true` | **Accessibility** |
| `mouse_down` | `{}` | `true` | **Accessibility** |
| `mouse_up` | `{}` | `true` | **Accessibility** |
| `cursor_position` | `{}` | `{x, y}` (virtual cursor; never the OS cursor) | none |
| `drag` | `{from?, to}` | `true` (`from` defaults to virtual-cursor pos) | **Accessibility** |
| `move_mouse` | `{x, y}` | `true` (moves the **virtual** cursor only) | none (hover post best-effort) |
| `scroll` | `{x, y, deltaX, deltaY}` | `true` | **Accessibility** |
| `frontmost_app` | `{}` | `{bundleId, displayName}` \| `null` | none |
| `app_under_point` | `{x, y}` | `{bundleId, displayName}` \| `null` | none |
| `list_installed_apps` | `{}` | `InstalledApp[]` (`{bundleId, displayName, path, iconDataUrl?}`) | none |
| `list_running_apps` | `{}` | `RunningApp[]` (`{bundleId, displayName}`) | none |
| `open_app` | `{bundleId}` | `true` | none |
| `check_permissions` | `{}` | `{accessibility, screenRecording}` | none |

**Shape notes (cross-checked against the TS normalizer):**

- `DisplayGeometry` emits **both** `id` *and* `displayId`, and **both** `name`
  *and* `label` — `normalizeDisplayGeometry` falls back `displayId ?? id` and
  `label ?? name`, but emitting both keeps every consumer happy.
  `scaleFactor = CGDisplayPixelsWide / CGDisplayBounds.width`.
- `ScreenshotResult` / `ResolvePrepareCaptureResult` carry the **flat** geometry
  fields (`width`, `height`, `displayWidth`, `displayHeight`, `displayId`,
  `originX`, `originY`) **and** a nested `display: DisplayGeometry`. `width`/
  `height` are read back from the produced `CGImage` (actual output pixels);
  `displayWidth`/`displayHeight` are the source display's logical points.
- `ResolvePrepareCaptureResult` additionally has `hidden: []` (v1 hides nothing)
  and `resolvedDisplayId == displayId` (v1 does not chase displays). The TS layer
  passes `autoResolve`/`doHide`; in v1 they are **ignored** (Python parity).
- All keyboard injection targets `NSWorkspace.frontmostApplication.pid`; all
  coordinate ops hit-test `CGWindowList` under the logical point → owner → pid.
  Every event is posted with **`CGEvent.postToPid(targetPid, …)`** — never
  `CGEventPost(.cghidEventTap, …)`, never any cursor-warp API.

---

## 5. Stable signing for TCC persistence

macOS keys Accessibility + Screen Recording grants to a binary's **code-signing
identity** (its designated requirement / cdhash lineage). An **ad-hoc** signature
(`codesign -s -`) or a per-build throwaway cert **rotates that identity on every
rebuild**, forcing the user to re-grant *both* permissions after every
`swift build`. To keep grants alive, [`build.sh`](./build.sh) **always** signs
with a **stable cert** and a **constant `--identifier`**, and **never** falls
back to ad-hoc.

```bash
./build.sh
# 1) swift build -c release --arch arm64 --package-path <pkg dir>
# 2) codesign --force --options runtime \
#      --identifier dev.cchaha.cu-helper \
#      --sign "Apple Development: 524134442@qq.com (F8ZSJJ78S7)" \
#      .build/release/cc-haha-computer-use
# 3) wraps and signs .build/release/cc-haha-computer-use.app
# 4) prints: built: <abs path to the app bundle>
```

- **Identity resolution.** `build.sh` prefers the real `Apple Development: …`
  identity if present (verified available on this machine as
  `Apple Development: 524134442@qq.com (F8ZSJJ78S7)`); then a release/CI
  `Developer ID Application: …` identity; then a self-signed `cu-helper-dev`
  cert. With none available it **stops** and prints one-time instructions. It
  **never** silently ad-hoc signs. Override with `CU_HELPER_IDENTITY` /
  `CU_HELPER_BUNDLE_ID`.
- **Timestamp policy.** Developer ID builds use `--timestamp` and verify that a
  secure `Timestamp=` exists because electron-builder deliberately preserves
  this nested app signature. Apple Development/self-signed builds default to
  offline `--timestamp=none`. `CU_HELPER_TIMESTAMP_MODE=secure` makes CI fail
  closed if the timestamp service cannot produce a distribution-ready signature.
- **`--options runtime`** (Hardened Runtime) keeps it dev-safe and
  notarization-ready for the Electron bundle.
- **Stability acceptance test** — build twice and confirm the signature is
  unchanged:

  ```bash
  codesign -dv --verbose=4 .build/release/cc-haha-computer-use.app 2>&1 | grep -E 'Identifier|Authority|Timestamp'
  # Identifier=dev.cchaha.cu-helper            <- constant across rebuilds
  # Authority=Apple Development: 524134442@qq.com (F8ZSJJ78S7)
  ```

  Identical `Identifier` + `Authority` across two builds ⇒ TCC grants survive a
  rebuild. If they differ, the user will be re-prompted — that's the bug this
  whole section exists to prevent.

---

## 6. Verification

### 6.1 Build + sign (agent-runnable)

```bash
./native/cu-helper/build.sh
# expect: built: .../native/cu-helper/.build/release/cc-haha-computer-use.app
```

### 6.2 TCC-free CLI smoke (agent-runnable — **no permissions needed**)

Each must print **exactly one** clean JSON line:

```bash
B=native/cu-helper/.build/release/cc-haha-computer-use.app/Contents/MacOS/cc-haha-computer-use
"$B" list_displays       --payload '{}'   # DisplayGeometry[] with id+displayId+name+label
"$B" get_display_size    --payload '{}'   # primary display (isPrimary:true)
"$B" frontmost_app       --payload '{}'   # {bundleId,displayName} | null
"$B" check_permissions   --payload '{}'   # {accessibility:bool, screenRecording:bool}
"$B" list_installed_apps --payload '{}'   # InstalledApp[]
"$B" list_running_apps   --payload '{}'   # RunningApp[]
"$B" cursor_position     --payload '{}'   # {x,y} (disk-persisted in CLI mode)
```

Pipe any of them through `python3 -m json.tool` (or `jq .`) to confirm the line
is valid JSON and there is no os_log/CoreGraphics leakage on stdout.

### 6.3 Self-test injection without cross-app TCC (agent-runnable)

`ensurePostable` permits posting to **`getpid()`** without Accessibility (the
self-test exemption). Posting a synthesized key to our own pid and reading it
back via an in-process responder exercises the full `CGEvent` construction +
`postToPid` path **without** needing Accessibility on another app — this proves
event *plumbing* is correct even where end-to-end cross-app delivery can't be
tested in CI.

### 6.4 Daemon smoke (agent-runnable — **no TCC**)

```bash
B=native/cu-helper/.build/release/cu-helper
"$B" daemon --socket /tmp/cu.sock        # prints {"ready":true,"pid":N,"proto":1}
# connect /tmp/cu.sock, then:
#   {"id":"1","cmd":"ping"}        -> {"id":"1","ok":true,"result":"pong"}
#   {"id":"2","cmd":"overlay_show"}  -> overlay appears; PHYSICAL cursor does NOT move
#   {"id":"3","cmd":"move_mouse","payload":{"x":900,"y":500}}  -> overlay GLIDES; real mouse free
#   {"id":"4","cmd":"shutdown"}    -> {"ok":true,"result":true}, process exits
```

`overlay_show` + `move_mouse` are the **eyeball test** for the core invariant:
the virtual cursor glides while the real mouse stays free.

### 6.5 Manual TCC checklist (**cannot** be done by a background agent)

Requires the user in **System Settings ▸ Privacy & Security**. Grant
**Accessibility** *and* **Screen Recording** to the signed `cu-helper` binary,
then verify — watching the **physical** mouse the whole time:

- [ ] `screenshot --payload '{"targetWidth":1280,"targetHeight":800,"jpegQuality":0.75}'`
      → non-empty base64; decoded image matches the display.
- [ ] Focus TextEdit, `type --payload '{"text":"héllo 世界"}'` → text appears
      (layout-independent unicode), **physical cursor unmoved**.
- [ ] `click` a button in another app → it activates, **physical cursor
      unmoved** (the virtual cursor glides to it in daemon mode).
- [ ] Double- / triple-click a word → word / line selection (click-state 1..N).
- [ ] `cmd+a` then `cmd+c` in a focused field → selects all, copies.
- [ ] `scroll` a long page → it scrolls. **Confirm the sign vs. natural-scroll**
      on a real scroll view and flip `deltaX`/`deltaY` sign if inverted (open
      question — cannot be settled without a real view + Accessibility).
- [ ] `drag` a selection → drag-select / move works (daemon overlay glides the
      path).
- [ ] `hold_key` shift+arrow then release → extends selection, then releases.
- [ ] **Rebuild + re-sign**, then repeat a `screenshot` and a `type` **without
      re-prompting** → confirms the stable-identity TCC persistence (§5).

---

## 7. Open questions (deferred for v1)

These are intentionally punted; each is safe for v1 per Python parity, but
listed so the manual tester knows what to watch:

1. **Scroll sign/axis** — `wheel1` = vertical, `wheel2` = horizontal; natural
   scroll inverts the sign. Verify on a real view (§6.5) and flip if needed.
2. **`resolve_prepare_capture`** is a straight display capture with `hidden:[]`
   and `resolvedDisplayId == displayId`. The full co-location / app-chase display
   resolver and app-hiding are deferred; the TS `autoResolve`/`doHide` flags are
   ignored (matches the current Python helper).
3. **CLI `cursor_position` cold start** — reads a disk-persisted point; if the
   *first* CU command of a session is `cursor_position` or a `drag` with no
   `from` before any `move_mouse`, it defaults to last-known / `(0,0)`. A
   non-issue in daemon mode (in-memory). The agent loop moves before dragging
   (`drag` passes an explicit `from` when available).
4. **`move_mouse` hover event** — whether to also post a real `.mouseMoved`
   `CGEvent` (improves hover-state fidelity, needs Accessibility + a resolved
   pid). Proposed: best-effort, swallowed if not trusted.
5. **Glow target selection** — v1 follows the **frontmost** app on
   `overlay_show`. Following the specific window under the last action point
   (richer, needs `windowID` tracking via `WindowFrameTracker`) is deferred.
6. **`iconDataUrl` cost** — `list_installed_apps` encodes a PNG data URL per app
   (`NSWorkspace.icon` → PNG → base64), adding latency. Proposed: include it (the
   desktop UI renders it); the optional `getAppIcon(path)` executor method exists
   as a lazier alternative if the cost proves too high.
