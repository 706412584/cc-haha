# Android local runtime device report: Black Shark SKW-A0

Use this report for the `spike/android-local-runtime-termux` branch Android local runtime validation.

## Device

- Device model: SKW-A0
- Manufacturer: blackshark
- Android version: 10
- CPU ABI: arm64-v8a
- Termux source: GitHub release `termux/termux-app` via `adb install`
- Termux version: 0.118.3 (`termux-app_v0.118.3+github-debug_arm64-v8a.apk`)
- Repo path: `/data/data/com.termux/files/home/cc-haha-h5-regression`
- Test date: 2026-07-09

## ADB baseline

Command:

```bash
adb devices -l
adb shell getprop ro.build.version.release
adb shell getprop ro.product.cpu.abi
adb shell getprop ro.product.model
adb shell getprop ro.product.manufacturer
adb shell pm list packages | grep -E 'termux|jackpal|connectbot' || true
```

Output:

```text
List of devices attached
9c18cb30               device product:SKW-A0 model:SKW_A0 device:skywalker transport_id:1

10
arm64-v8a
SKW-A0
blackshark

(no Termux-like package detected)
```

## Device access notes

- ADB debugging: enabled and authorized.
- Shared storage: `/sdcard` exists and points to `/storage/self/primary`.
- Default browser intent: resolves to `com.ume.browser.hs` / `com.ume.sumebrowser.BrowserActivity`.
- Termux data directory: `/data/data/com.termux` exists after install.
- Termux bootstrap: `files/usr/bin/bash` and `apt` exist; absolute `apt --version` works through `run-as`.

## Environment probe

Command:

```bash
bun run scripts/android-local-runtime/check-env.ts
```

Paste output:

```text
Termux installed and base packages installed via apt.

node: v24.17.0
npm: 11.18.0
git: 2.55.0
python: 3.14.6
make: 4.4.1
clang: 21.1.8

Official Bun installer completed, but the downloaded binary cannot execute on Termux/Android:
run-as: exec failed for /data/data/com.termux/files/home/.bun/bin/bun: No such file or directory

readelf shows the binary requests the glibc interpreter:
[Requesting program interpreter: /lib/ld-linux-aarch64.so.1]

Termux/Android does not provide that loader path. Termux apt search did not find a native bun package.
```

## Server startup

Command:

```bash
CLAUDE_H5_DIST_DIR=/path/to/desktop/dist \
  bun run src/server/index.ts --host 127.0.0.1 --port 3456
```

Result:

- [ ] Started successfully
- [ ] Failed before listening
- [ ] Failed after listening
- [x] Bun server not attempted because Bun is not runnable on Termux/Android
- [x] Node smoke server started successfully
- [x] Node-compatible server slice started successfully

Paste server log excerpt:

```text
[android-node-smoke] listening at http://127.0.0.1:3456
[android-node-slice] listening at http://127.0.0.1:3459
[android-node-slice] h5 dist: /data/data/com.termux/files/home/cc-haha-probe/h5-dist

2026-07-09 mobile H5 regression attempt:
[android-node-slice] listening at http://127.0.0.1:3459
[android-node-slice] h5 dist: /data/data/com.termux/files/home/cc-haha-h5-regression/desktop/dist

Follow-up host binding check:
[android-node-slice] listening at http://0.0.0.0:3461
[android-node-slice] h5 dist: /data/data/com.termux/files/home/cc-haha-h5-regression/desktop/dist
LISTEN 0.0.0.0:3461

Interactive Termux app shell retry:
[android-node-slice] listening at http://127.0.0.1:3459
[android-node-slice] h5 dist: /data/data/com.termux/files/home/cc-haha-h5-regression/desktop/dist
```

## Transport probe

Command:

```bash
bun run scripts/android-local-runtime/check-server.ts http://127.0.0.1:3456
```

Result:

- [x] `/health` passed
- [x] WebSocket `ping`/`pong` passed
- [ ] Failed
- [x] Passed with Node smoke server/client inside Termux

Paste output:

```text
Android Node transport client probe
===================================
Base URL: http://127.0.0.1:3456
Session: android-node-1783429849657

[OK] GET /health -> {"status":"ok","timestamp":"2026-07-07T13:10:49.690Z"}
[OK] WebSocket ping -> {"type":"pong"}

Android Node server slice client probe
======================================
Base URL: http://127.0.0.1:3459

[OK] GET /health -> {"status":"ok","timestamp":"2026-07-07T14:29:24.442Z"}
[OK] GET /api/sessions -> 0
[OK] POST /api/sessions -> 655fe716-06d9-4b5c-b21f-d30f089d1341
[OK] created session appears in list
[OK] GET /api/sessions/:id/messages -> 0
[OK] WebSocket ping -> {"type":"pong"}
[INFO] GET / -> HTTP 200

2026-07-09 mobile H5 regression attempt:
Android Node server slice client probe
======================================
Base URL: http://127.0.0.1:3459

Error: connect ETIMEDOUT 127.0.0.1:3459

A minimal Node HTTP loopback probe in the same `run-as com.termux` context also timed out:
listen 41073
TimeoutError: The operation was aborted due to timeout

A minimal Node TCP loopback probe also timed out:
listen 43477
timeout

Binding the server slice to `0.0.0.0:3461` also listened successfully, but probes to both `http://192.168.1.2:3461/health` from the `run-as com.termux` context and from the desktop host timed out. Android system shell loopback was checked separately with `nc -l -p 3470` and succeeded, which narrows the blocker to processes launched via `run-as com.termux` rather than Android loopback globally.

Interactive Termux app shell retry succeeded after using `adb shell input text` with `%s` for spaces instead of literal `%20`:
[OK] GET /health -> HTTP 200
[OK] GET /api/status -> runtime android-node-slice
[OK] startup settings/model/trace stub APIs responded
[OK] H5 first screen reached in `com.ume.browser.hs` after lowering the renderer build target from ES2021 to ES2020/Chrome 81-compatible output and adding the minimum Node slice startup APIs.
```

## H5 browser check

Open:

```text
http://127.0.0.1:3456/
```

Checklist:

- [x] H5 first screen loads
- [ ] Session list/create works
- [ ] WebSocket stays connected
- [x] Text input works with soft keyboard
- [ ] Long chat scroll works
- [ ] Copy/paste works
- [ ] File picker behavior observed
- [ ] Background/lock-screen behavior observed
- [ ] Not attempted yet
- [ ] Blocked before browser check by Termux `run-as` loopback timeout
- [x] Blocked after first screen by mobile shell/layout verification on `com.ume.browser.hs`

Notes:

```text
2026-07-09: latest `desktop/dist` was built and pushed to `/data/data/com.termux/files/home/cc-haha-h5-regression/desktop/dist` with `MSYS_NO_PATHCONV=1` after an initial Git Bash path-conversion push failure. Node server slice scripts were pushed to `/data/data/com.termux/files/home/cc-haha-h5-regression/scripts`.

The Node-compatible server slice logged that it was listening on `127.0.0.1:3459`, and `ss -ltnp` showed `LISTEN 127.0.0.1:3459`. However, the Node slice client timed out connecting to `127.0.0.1:3459`. Minimal Node HTTP and TCP loopback probes in the same `run-as com.termux` context also timed out while connecting to their own freshly opened `127.0.0.1` ports.

A follow-up `--host 0.0.0.0 --port 3461` run also listened successfully, but both `192.168.1.2:3461` from `run-as com.termux` and from the desktop host timed out. Android system shell loopback with `nc` succeeded, so the next validation should launch the server from the interactive Termux app shell instead of `adb shell run-as com.termux`.

Interactive Termux app shell validation then started the Node slice successfully on `127.0.0.1:3459`. The first browser attempt exposed a Chrome 81 syntax compatibility issue: the renderer bundle preserved ES2021 logical assignment (`??=` / `||=`), so the startup watchdog fired before React mounted. Lowering the desktop renderer target to ES2020/Chrome 81-compatible output fixed that parse blocker; generated JS assets parsed as ES2020 and the entry no longer contained logical assignment operators.

After adding `/api/status` plus the minimum startup settings/model/trace APIs to the Node slice, `com.ume.browser.hs` reached the H5 new-session screen and the soft keyboard opened on text input. Mobile shell/layout validation remains incomplete on this browser: the page still rendered with desktop-scale layout in the captured run even with `forceMobile=1`, so settings-entry and app-like shell UX need a follow-up browser/runtime diagnosis.
```

## Classification

Choose one:

- [ ] Viable
- [ ] Viable with replacement
- [ ] Not viable yet
- [x] Viable with replacement

Blocking layer, if any:

- [ ] Termux/package manager
- [x] Bun runtime
- [x] Node/runtime fallback
- [ ] Server startup
- [x] WebSocket/network
- [ ] File system/workspace
- [ ] Claude/agent CLI
- [x] H5 mobile UI

Summary:

```text
USB debugging is connected. Termux 0.118.3 installed successfully from the official GitHub arm64-v8a APK. apt works with the Termux PATH, and base development packages installed successfully: Node, npm, git, python, make, and clang. Official Bun installer downloads a Linux aarch64 binary that requests /lib/ld-linux-aarch64.so.1, so Bun is not directly runnable on Android/Termux.

Node fallback remains the replacement path. The 2026-07-09 mobile H5 regression run exposed a `run-as com.termux` loopback connectivity blocker: Node can listen on `127.0.0.1`, but Node HTTP/TCP clients in the same `run-as` context time out connecting to that loopback port. Launching from the interactive Termux app shell works and serves H5 to the device browser.

The H5 path now reaches the new-session screen after two fixes: desktop renderer output must be Chrome 81/ES2020-compatible, and the Node slice must provide the minimum startup API surface (`/api/status`, settings/model/trace reads, sessions, and WebSocket ping/pong). Remaining blocker is app-like mobile UX validation in `com.ume.browser.hs`: the first screen and soft keyboard work, but captured layout still appears desktop-scaled and settings-entry validation is incomplete.
```
