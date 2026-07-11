# Adapter Instructions

These rules apply to `adapters/` changes in addition to the root instructions.

- Reuse shared adapter utilities and keep platform-specific behavior within the relevant Telegram, Feishu, WeChat, or DingTalk package.
- Install adapter dependencies in `adapters/` on a fresh checkout; do not change root dependencies for an adapter-only task without a verified need.
- Add focused tests for the affected adapter, then follow `bun run check:impact`; adapter changes normally select `bun run check:adapters`.
- Required tests must not call real messaging platforms or use saved accounts/tokens. Use fixtures, mocked transports, and temporary session/config paths.
- Do not read or mutate the user's real adapter bindings or session files during tests.
