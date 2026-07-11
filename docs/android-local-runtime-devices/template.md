# Android local runtime device report

Use this template for each real Android/Termux device tested on the `spike/android-local-runtime-termux` branch.

## Device

- Device model:
- Android version:
- CPU ABI:
- Termux source: F-Droid / GitHub / other
- Termux version:
- Repo path:
- Test date:

## Environment probe

Command:

```bash
bun run scripts/android-local-runtime/check-env.ts
```

Paste output:

```text

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

Paste server log excerpt:

```text

```

## Transport probe

Command:

```bash
bun run scripts/android-local-runtime/check-server.ts http://127.0.0.1:3456
```

Result:

- [ ] `/health` passed
- [ ] WebSocket `ping`/`pong` passed
- [ ] Failed

Paste output:

```text

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

Notes:

```text

```

## Classification

Choose one:

- [ ] Viable
- [ ] Viable with replacement
- [ ] Not viable yet

Blocking layer, if any:

- [ ] Termux/package manager
- [ ] Bun runtime
- [ ] Node/runtime fallback
- [ ] Server startup
- [ ] WebSocket/network
- [ ] File system/workspace
- [ ] Claude/agent CLI
- [ ] H5 mobile UI

Summary:

```text

```
