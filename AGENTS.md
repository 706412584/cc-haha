# Repository Instructions

This is a routing guide for coding agents. Keep shared instructions model-independent; put task-specific detail next to the code or in the linked guides.

Rules closer to the code take precedence. For the directory you are changing, read the nested `AGENTS.md` in that directory and any applicable ancestors. Load other documentation when the task needs it.

## Start Here

- Run `git status --short` before editing. Preserve all existing user changes and never revert, restage, reformat, or overwrite unrelated work.
- Identify the affected surface and inspect its production path, nearest tests, and existing implementation pattern before proposing a change. Check recent history when regression context matters.
- For bugs, reproduce the failure or add a regression test that fails for the intended reason. If reproduction is impossible, state the limitation instead of guessing.
- Define the smallest behavior change and the proof that will demonstrate it. Stop and re-scope if the diff crosses an unplanned surface, adds a dependency, or grows beyond the verified seam.
- The primary agent owns understanding, implementation, focused testing, integration, and final verification. Do not delegate simple lookup, planning, local edits, or ordinary test execution.
- Use subagents only when isolation or genuine parallelism repays their context/coordination cost: independent review or verification, a complex bug investigation that benefits from a separate context, or multiple implementation tasks with non-overlapping file ownership. When implementation agents run in parallel, the primary agent must retain and actively continue at least one executable task.
- Tool access is capability, not authorization. Do not create/switch branches, commit, push, open or merge a PR, publish a release, change repository settings, or spend live-provider quota unless the user explicitly requests that operation.

## Repository Map

| Surface | Entry point |
| --- | --- |
| CLI, tools, runtime, local API/WebSocket server | [src/AGENTS.md](src/AGENTS.md) |
| React desktop UI, Electron host, native/sidecars | [desktop/AGENTS.md](desktop/AGENTS.md) |
| IM platforms and shared chat runtime | [adapters/AGENTS.md](adapters/AGENTS.md) |
| Chinese and English product/source documentation | [docs/AGENTS.md](docs/AGENTS.md) |
| React documentation site and build tooling | [site/AGENTS.md](site/AGENTS.md) |
| CI and quality policy | [.github/AGENTS.md](.github/AGENTS.md), `scripts/pr/`, `scripts/quality-gate/` |
| Desktop releases and auto-update | `release-notes/`, `scripts/release.ts`, [release guide](docs/internals/contributing.md#发版与自动更新) |

## Implementation Rules

- Keep changes tied to the requested behavior. Reuse existing utilities, stores, services, and test harnesses; add dependencies or abstractions only when the task needs them.
- Computer Use has one app-authorization boundary on both macOS and Windows: enabling it in Settings and confirming its consent dialog authorizes all apps. Do not add per-app prompts, allowlists, denylists, category-based access tiers, or host/helper exceptions after that consent. Global disablement, OS permissions, and target/process validity checks still apply.
- Executable JS/TS production changes under `src/`, `desktop/src/`, or `adapters/` require a same-area regression test unless a maintainer explicitly approves an exception. For bugs, reproduce the failure or add a test that fails for the intended reason; report when reproduction is unavailable. Test the behavior and affected boundaries. See [test design](docs/internals/contributing.md#回归测试设计) for state transitions, replay, and coverage caveats.
- Keep TypeScript ESM style: 2-space indentation, no semicolons, `PascalCase` components, and `camelCase` functions/hooks/stores. Use structured parsers and existing boundaries for structured data.
- Do not commit generated output such as `artifacts/`, coverage reports, `node_modules/`, build directories, or Rust `target/` trees.
- When publishing is explicitly requested, use Conventional Commit subjects and normal product branch prefixes such as `fix/`, `feat/`, or `docs/`; do not create `codex/` branches in this repository.
- After a branch is merged, promptly clean up its local/remote branch plus associated Git worktrees, build worktrees, and temporary directories. Destructive cleanup requires explicit user authorization: inspect each worktree first, preserve existing changes unless discarding them was explicitly authorized, verify repository ownership and remote-delete permission, and limit scans/deletions to authorized repository-owned paths. Confirm cleanup with `git worktree list` and a scoped directory scan so stale registrations and hidden worktrees do not keep consuming disk.

## Writing a Test That Holds

Most regressions here are repairs of a recent repair: 21 of the last 70 `fix` commits
edit lines another `fix` wrote within 30 days. Coverage is not the missing signal —
`ContextUsageIndicator.tsx` sits at 87% branch coverage and was fixed three times in
ninety minutes. What those tests had in common is shape, so choose it deliberately.

- **Drive the transition; never hand-write the state it produces.** Component tests in
  `desktop/src` call `setState` 744 times and a real store action 3 times. State you
  assigned is self-consistent by construction and cannot expose "transition A did not
  update B" — which is where these bugs live. Use `handleServerMessage`, store actions,
  and real user events.
- **Assert the invariant, not today's output.** `2262973a4` shipped
  `expect(getByText('deepseek-reasoner'))` at a moment when the screen showed another
  model's number: it wrote the bug in as a passing assertion, and the next fix had to
  invert that exact line. Ask what must be true after this step, not what it prints now.
- **Cover both directions of any rule that drops or merges something.** The replay guard
  was tested for "a replay must be discarded" and never for "a genuine repeat must be
  kept", so it shipped dropping real replies.
- **Test the join, not each end.** Server, store, and component each had a test for
  `runtime_config_applied`; nothing crossed them, and deleting the term that joins them
  (`ChatInput.tsx` `refreshNonce`) left 314 tests green.
- **Never retune an existing test's inputs to keep it green.** `128f75ab5` changed five
  tests' props (`messageCount={0}` → `{1}`) instead of accepting that they described
  states a real session cannot reach. If a test only passes after you edit its inputs,
  the test was describing the implementation.
- **Do not mock the module under test.** A hand-written factory freezes an interface
  snapshot: the store can be renamed or gutted and the test still passes.
- **If you are comparing content to decide identity, the identity exists upstream.**
  Deduping by text cannot separate a replay from a legitimate repeat; forward the id
  (`uuid`, `toolUseId`) instead of guessing.

Blind spots to check rather than trust:

- `desktop/electron/` is not instrumented at all (`vitest.config.ts` collects only
  `desktop/src`), so main-process diffs score zero covered lines.
- Bun's LCOV emits no branch records, so `src/` and `adapters/` report **100% branch
  coverage** for data that was never collected (`pct(0, 0) === 100`). Only `desktop/`
  has real branch numbers.

## Verification

- `bun run check:impact` selects the required checks using paths and imports. Run the selected checks for the final diff; use focused tests while fixing failures. `package.json` and `scripts/pr/change-policy.ts` are the command and routing sources of truth.
- Use `bun run verify` when full validation is requested or before claiming a code change is PR-ready or push-ready. It runs the selected PR lanes, so there is no need to run every lane separately first. Reuse passing results for unchanged code; rerun or broaden checks when subsequent edits, failures, or unresolved risks warrant it.
- Required PR checks must be deterministic: no real models, public network, repository secrets, saved providers, or real user home/config. Use fake credentials, fixtures, mocked/loopback transports, temporary directories, and cleanup. Server-booting quality lanes use `scripts/quality-gate/sandbox.ts` and must fail on real user-state writes.
- For user-visible desktop or cross-process changes that unit tests cannot prove, exercise a browser/desktop smoke path. Ad-hoc browser work uses the `ego-browser` skill; `agent-browser` is reserved for the committed smoke lane and `desktop/scripts/e2e-*-agent-browser.sh`. See the [deterministic agent/UI lanes](docs/internals/contributing.md#无模型的端到端-agent-门禁).
- Live model checks are separate maintainer evidence after deterministic checks pass and quota use is explicitly authorized; finding credentials on the machine is not authorization.

## User-State Safety

- Never use or mutate the developer's real `~/.claude`, keychain, tokens, transcripts, providers, or project settings in tests. Redirect every relevant path to a temporary directory.
- Treat `~/.claude/settings.json` as user-owned shared state: preserve unknown fields, merge additively, and never add a repository-owned global schema marker.
- Any persisted JSON, `localStorage`, or app-config shape change requires a forward migration, an old-fixture regression test, and `bun run check:persistence-upgrade`.
- Repair/Doctor flows are deny-by-default. Automatic repair may change only explicitly allowlisted, regenerable desktop UI state; protected user data requires a reviewed, backup-first manual flow.

## Handoff

- Review `git diff --check`, `git diff`, and `git status --short` before reporting completion.
- Report changed files, tests added, commands actually run and their observed results, checks not run, blockers, and remaining risk. Distinguish `passed`, `failed`, `skipped`, `blocked`, and `not run`; build-only, mock, live, and stale evidence are not interchangeable.
- Contributor workflow, failure diagnosis, and instruction maintenance: [CONTRIBUTING.md](CONTRIBUTING.md) and [detailed guide](docs/internals/contributing.md). PR evidence: [.github/pull_request_template.md](.github/pull_request_template.md).
