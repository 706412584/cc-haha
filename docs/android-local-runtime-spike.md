# Android local runtime spike

This experimental track explores whether cc-haha can run as a local developer workspace on Android instead of only acting as a desktop companion client.

## Goal

Prove or disprove the smallest useful loop:

1. Start the cc-haha server inside an Android Linux-like userland, such as Termux.
2. Serve the existing H5 UI from the same local server.
3. Open the UI in Android WebView or a browser at `http://127.0.0.1:3456/`.
4. Verify REST, WebSocket, chat/agent, and workspace access.

This is a spike, not a productized Android release path.

## Branch

Use a long-running experimental branch:

```bash
git checkout -b spike/android-local-runtime-termux
```

Keep this branch isolated from normal desktop/H5 releases until the runtime feasibility is proven.

## Phase 1 scope

In scope:

- Termux or Termux-like environment probing.
- Local server startup on `127.0.0.1`.
- Static H5 served by the local server.
- `/health` verification.
- Basic REST session creation/listing.
- WebSocket connection to `/ws/:sessionId`.
- One minimal chat/agent loop if the local CLI/runtime can start.
- Basic workspace read/write checks in an Android-accessible directory.

Out of scope:

- Play Store packaging.
- Embedding Termux inside the app.
- Capacitor/Android native shell implementation.
- Background service hardening.
- Push notifications.
- Native terminal UI.
- LSP completeness.
- Cloudflare tunnel.
- IM adapters.
- Auto-update.

## Environment probe

Run this first in the Android userland:

```bash
bun run scripts/android-local-runtime/check-env.ts
```

The probe reports availability for:

- `uname`
- `node`
- `npm`
- `bun`
- `git`
- `python`
- `pkg`

For Phase 1, `bun` and `git` are treated as required. If Bun is unavailable or unstable on Android, record that result before trying alternatives.

## Candidate Termux setup

Do not assume these packages are available on every device. Treat this as a candidate path:

```bash
pkg update
pkg install nodejs-lts git python make clang
```

Bun compatibility must be tested separately on the target device/ABI.

## Server startup

Build H5 on a supported desktop first, or otherwise provide a valid `desktop/dist` directory.

Then start the local server from the repository root:

```bash
CLAUDE_H5_DIST_DIR=/path/to/desktop/dist \
  bun run src/server/index.ts --host 127.0.0.1 --port 3456
```

The server has an unauthenticated health endpoint:

```bash
curl http://127.0.0.1:3456/health
```

Expected shape:

```json
{"status":"ok","timestamp":"..."}
```

Run the transport probe after the server is listening. It is expected to fail with a connection error until the server finishes startup:

```bash
bun run scripts/android-local-runtime/check-server.ts http://127.0.0.1:3456
```

The probe verifies both `GET /health` and WebSocket `ping`/`pong` on `/ws/:sessionId`. If you pass a custom session id, it must match the server route constraint: `/^[0-9a-zA-Z_-]{1,64}$/`.

## H5/WebView target

Open the UI at:

```text
http://127.0.0.1:3456/
```

For the first spike, prefer same-origin serving from the local server. Same-origin avoids CORS and token complexity while testing the runtime itself.

## Minimum acceptance checklist

- [ ] `bun run scripts/android-local-runtime/check-env.ts` completes and records environment state.
- [ ] `bun run src/server/index.ts --host 127.0.0.1 --port 3456` starts without crashing.
- [ ] `GET /health` returns `status: ok`.
- [ ] H5 loads from `http://127.0.0.1:3456/`.
- [ ] `POST /api/sessions` succeeds.
- [ ] `GET /api/sessions` succeeds.
- [ ] WebSocket connects to `/ws/:sessionId`.
- [ ] A minimal chat/agent request streams output, or the runtime blocker is captured.
- [ ] Workspace tree/file APIs work against a small Android-local test directory.
- [ ] Lock screen / background behavior is observed and recorded, even if it fails.

## Decision gate

After Phase 1, classify the path as one of:

1. **Viable:** local runtime can support an Android developer workspace.
2. **Viable with replacement:** server works, but Bun or Claude CLI must be replaced/adapted.
3. **Not viable yet:** Android restrictions or runtime dependencies block the local model.

Only consider embedding a Termux-like runtime after the spike reaches **Viable** or **Viable with replacement**.
