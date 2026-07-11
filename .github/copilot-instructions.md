# AI Coding Instructions

Follow the root `AGENTS.md` and the nearest nested `AGENTS.md` for the files you edit.

For every feature, bugfix, refactor, or workflow change:

- Treat tool access as capability, not authorization. Do not commit, push, open/merge a PR, release, run live providers, or change repository settings unless explicitly requested.
- Inspect `git status --short`, identify the changed surface, define the intended behavior and failure signal, and inspect the nearest implementation and tests before editing.
- Identify the changed surface before coding: `desktop`, `server/runtime`, `adapter`, `native`, `docs`, `provider/runtime`, `agent-loop`, `persistence`, `policy/ci`, or `release`.
- Add same-area tests with the production change. Do not leave production behavior untested unless the PR explicitly carries the maintainer override `allow-missing-tests`.
- Preserve or improve the coverage ratchet. New or changed executable production lines must pass the changed-line coverage threshold in `scripts/quality-gate/coverage-thresholds.json`; do not edit coverage baselines or thresholds without maintainer approval via `allow-coverage-baseline-change`.
- Use unit tests for pure logic, API/request-shape tests for server/provider/runtime behavior, Testing Library/Vitest for desktop UI and stores, and E2E or agent-browser smoke for user-visible cross-boundary flows.
- Provider/auth/runtime-env/model-window/proxy changes require offline `bun run check:provider-contract`; desktop chat/WebSocket/session-runtime changes require `bun run check:chat-contract`.
- Required PR evidence must be deterministic: use fake credentials, temporary config/home paths, mocked or loopback transports, explicit cleanup, and restored environment state. Never call a real provider or use saved machine credentials in required tests.
- For agent loop, tool execution, provider routing, model selection, file editing, permissions, session resume, and desktop chat changes, include mock/fixture/contract tests. Live smoke is trusted-maintainer evidence only and requires explicit authorization; finding local credentials is not authorization.
- Run the focused regression first, then `bun run check:impact` and every selected surface/contract check. Run `bun run verify` only before claiming PR-ready/push-ready or when full validation was requested.
- Do not present skipped, blocked, not-run, mock, build-only, or stale evidence as passed live/runtime verification.
- In the final handoff or PR description, include changed files, tests added, commands actually run with pass/fail counts, checks not run, coverage report path when generated, deterministic E2E evidence, live report path or explicit maintainer-only deferral, and known residual risk.
