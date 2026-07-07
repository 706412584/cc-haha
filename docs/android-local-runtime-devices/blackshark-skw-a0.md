# Android local runtime device report: Black Shark SKW-A0

Use this report for the `spike/android-local-runtime-termux` branch Android local runtime validation.

## Device

- Device model: SKW-A0
- Manufacturer: blackshark
- Android version: 10
- CPU ABI: arm64-v8a
- Termux source: GitHub release `termux/termux-app` via `adb install`
- Termux version: 0.118.3 (`termux-app_v0.118.3+github-debug_arm64-v8a.apk`)
- Repo path: pending
- Test date: 2026-07-07

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
```

## H5 browser check

Open:

```text
http://127.0.0.1:3456/
```

Checklist:

- [ ] H5 first screen loads
- [ ] Session list/create works
- [ ] WebSocket stays connected
- [ ] Text input works with soft keyboard
- [ ] Long chat scroll works
- [ ] Copy/paste works
- [ ] File picker behavior observed
- [ ] Background/lock-screen behavior observed
- [x] Not attempted yet

Notes:

```text
pending
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
- [ ] WebSocket/network
- [ ] File system/workspace
- [ ] Claude/agent CLI
- [ ] H5 mobile UI

Summary:

```text
USB debugging is connected. Termux 0.118.3 installed successfully from the official GitHub arm64-v8a APK. apt works with the Termux PATH, and base development packages installed successfully: Node, npm, git, python, make, and clang. Official Bun installer downloads a Linux aarch64 binary that requests /lib/ld-linux-aarch64.so.1, so Bun is not directly runnable on Android/Termux. Next step is Node/runtime fallback validation for the cc-haha server path.
```
