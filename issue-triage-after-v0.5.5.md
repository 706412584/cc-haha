# Issue triage after v0.5.5

## Scope

- Baseline release: `v0.5.5`
- Baseline issue: `#1238` (`fix(models): preserve GPT relay reasoning effort`)
- Initial GitHub snapshot: 2026-09-01, issues `#1239` through `#1290`
- Snapshot size: 42 issues (30 open, 12 closed); pull requests are excluded
- Final GitHub rescan: 2026-09-01; no issue above `#1290`
- Policy: do not change GitHub issue state or labels during this work. A confirmed
  fix or accepted small feature is complete only after its isolated session has been
  verified and merged into local `main`.

## Outcome

- 12 issues were already closed upstream and required no local change.
- 10 issue reports were handled by 8 isolated implementations and merged into local
  `main`; duplicate reports `#1272` and `#1288` are covered by the `#1271` repair.
- 20 open issues were deferred because they could not be reproduced on macOS, lacked
  enough evidence for a safe fix, were already supported, or were not very small
  features. Their evidence and deferral reasons are recorded below.

## Tracking

| Issue | Upstream state | Triage | macOS reproduction | Isolated session | Local main |
| --- | --- | --- | --- | --- | --- |
| #1239 | open | Deferred: provider/configuration plus insufficient evidence | Current behavior maps semantic context overflow correctly; reported ambiguous 404 not reproduced as a product defect | Not needed | No change |
| #1240 | open | Confirmed product Bug | Reproduced on current `main`: Markdown images are removed from prose and collected at the end | `01a05d06-041e-7182-88db-5f3156d1119b`, commit `a1ddc2734` | Merged as `b1ecce781` |
| #1242 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1243 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1244 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1245 | open | Current `main` already contains the relevant Windows/chat scroll fixes; awaiting reporter confirmation | Current macOS tests pass; old Windows-only behavior cannot be reproduced on macOS | Not needed | No change |
| #1246 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1247 | open | Deferred: incomplete usage question, no environment or reproduction | Not reproducible from supplied information | Not needed | No change |
| #1251 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1252 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1253 | closed | Already closed upstream; fixed in v0.5.5 | Not needed | Not needed | No change |
| #1254 | open | Deferred: suspected Bug but insufficient provider/runtime evidence | Full repeated plan/approve/re-enter sequence completed on current `main` without truncation | Not needed | No change |
| #1255 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1256 | open | Deferred: current code already supports per-session Qwen reasoning effort; report lacks protocol/runtime details | Loopback Qwen-compatible upstream received `reasoning_effort=high` and completed | Not needed | No change |
| #1257 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1259 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1260 | open | Deferred: v0.5.4 hang path is covered by v0.5.5 watchdog fix; current report lacks response/log evidence | Current truncated-tool stream terminates within configured bounds | Not needed | No change |
| #1261 | open | Deferred: empty report and current `main` cannot reproduce the title-only scroll failure | Nine real Bash/permission cycles retained auto-follow and manual scrolling in isolated macOS UI | Not needed | No change |
| #1262 | closed | Already closed upstream | Not needed | Not needed | No change |
| #1263 | open | Deferred: product usage question rather than a reported defect or scoped feature | Not needed | Not needed | No change |
| #1264 | open | Confirmed Telegram delivery Bug | Reproduced with production buffer/formatter and injected 429: visible reply truncates while delivery state is cleared | `01a05d09-acbb-7163-9c62-a57fed65e4ba`, commit `ba4ecf47b` | Merged as `c0f3318d9` |
| #1266 | open | Confirmed retry-message clarity Bug | Reproduced through current retry conversion and JSDOM: `rate_limit` is shown only as HTTP 429 plus 13570 raw seconds | `01a05d0d-acc9-70d2-8782-3c5fc5dbd1d1`, commit `b7e7674a5` | Merged as `ee1efaff0` |
| #1268 | open | Deferred: multi-harness support is an XL cross-layer feature, not a small feature | Not applicable | Not needed | No change |
| #1269 | open | Confirmed DeepSeek reasoning round-trip Bug | Reproduced through proxy + loopback: generic host drops `reasoning_content` and upstream returns 400 | `01a05d12-b0a8-7313-8611-1f59c5758ed0`, commit `2806f750e` | Merged as `ece7c54c4` |
| #1270 | open | Deferred: evidence points to Tencent iLink/mobile account authorization; repository defect not demonstrated | Local old-protocol QR/status flow works; real mobile authorization intentionally not attempted | Not needed | No change |
| #1271 | open | Confirmed tool-input watchdog regression | Time-compressed macOS stream is aborted despite continuous valid `input_json_delta` progress | `01a05d12-591a-7d22-bb63-cd94d02a97d2`, commit `c6679afea` | Merged as `5eecf5cbc` |
| #1272 | open | Duplicate Bug: same watchdog signature and root cause as #1271 | Reproduced same progressing-stream false positive | Covered and verified by #1271 session | Fixed by `5eecf5cbc` |
| #1273 | open | Accepted small feature: expose existing conversation-only rewind for pure-chat/error turns | Not applicable | `01a05d18-15cd-7af0-94ba-1b1e654bc14e`, commit `65d0e6a0a` | Merged as `aa237f2c2` |
| #1274 | open | Deferred: already supported via global attribution settings; usage/discoverability question | Not applicable | Not needed | No change |
| #1275 | open | Deferred: 600-second total stream cap is an intentional anti-drip protection; configurability needs product scope | Short-cap macOS loopback terminates a healthy long-thinking stream; a raised cap allows the same stream to complete | Not needed | No change |
| #1277 | open | Confirmed Computer Use image conversion Bug | Reproduced through real proxy chain: Chat drops tool-result images while Responses preserves them | `01a05d1f-0c7d-7610-8414-3833e9ecf76d`, commit `e8b74a8dd` | Merged with #1269 conflict resolution as `cf9d6c41a` |
| #1279 | open | Deferred: Anthropic Base URL was configured with `/v1`; current root-URL behavior is correct | Root URL produces `/v1/messages`; user-supplied `/v1` produces `/v1/v1/messages` | Not needed | No change |
| #1280 | closed | Already closed upstream; empty report | Not needed | Not needed | No change |
| #1281 | open | Deferred: partial transcript deletion is a high-risk persisted graph rewrite, not a small feature | Not applicable | Not needed | No change |
| #1283 | open | Confirmed GLM 5.3 reasoning-capability Bug | Real CLI→loopback sends invalid adaptive thinking and reproduces 400/1210; required thinking succeeds | `01a05d25-6bf2-7f10-8e4a-14bdb0e28ae3`, commit `c59a551c9` | Merged as `8d8169ea7` |
| #1284 | open | Deferred: suspected Windows-specific 5k-row virtualization/painting issue; macOS cannot reproduce | Real macOS UI loaded 5,427 durable rows and scrolled mid/top during active task without blank content | Not needed | No change |
| #1285 | open | Deferred: unreviewed high-risk third-party plugin plus a large runtime feature | Not applicable | Not needed | No change |
| #1286 | open | Deferred: Telegram already has `/resume`; unspecified all-IM parity is a cross-adapter medium feature | Not applicable | Not needed | No change |
| #1287 | open | Deferred: no 30-day cutoff; older sessions are grouped under Earlier/search, while the real 400-item cap needs pagination | Related fixtures and sidebar/store/search tests pass | Not needed | No change |
| #1288 | open | Duplicate Bug: same progressing tool-input watchdog root cause as #1271/#1272 | Reproduced with continuous deltas at a compressed timeout | Covered and independently reverified against #1271 commit | Fixed by `5eecf5cbc` |
| #1289 | open | Deferred: Windows-only clipboard/virtualization candidate; macOS cannot reproduce | Real active-task UI copied prompt/reply correctly both before and after virtualization | Not needed | No change |
| #1290 | open | Deferred: already configurable through `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; dedicated per-model UI is not a small feature | Isolated evaluation confirms 16K override and 64K custom-model cap | Not needed | No change |

## Deferred details

### #1239

The current code preserves upstream error bodies and classifies known context-overflow
signals before generic HTTP 404 model errors. An offline macOS loopback reproduction
confirmed that semantic overflow responses become `Prompt is too long`, while a bare
404 remains a model-routing error. The report used an explicit 1,000,000-token Luna
configuration and did not include the raw upstream 404 response, runtime commit,
normalized provider configuration, or auto-compact state. Reinterpreting every 404 as
context overflow would introduce false positives, so no safe product change is justified.

### #1245

The report is from Windows desktop v0.5.3. The current branch includes the v0.5.4
Windows chat-rendering fix and the v0.5.5 virtual-row stabilization. Long transcript,
history-window, send-to-bottom, tab restore, and subagent-return tests all pass on macOS.
The issue has no steps, screenshot, DPI/scale, or current-version confirmation, so no
additional fix can be scoped safely.

### #1254

An isolated macOS run exercised plan mode, approval, implementation, a second plan-mode
entry, a second approval, and a second implementation in the same session. All four
turns completed and all permission transitions were acknowledged. The report does not
identify the provider, model, prompt, last tool call, event ID, diagnostic output, or
whether the upstream stream ended early, so the current code path cannot be implicated.

### #1256

Current `main` gives unknown Qwen models the generic reasoning profile and passes the
selected session effort through `output_config.effort` to OpenAI Chat
`reasoning_effort`. A macOS loopback reproduction captured `qwen3.8` with
`reasoning_effort=high` and a successful response. The report omits provider format,
local inference server/version, request trace, expected upstream field, and error body;
nonstandard servers that require a different field are an upstream protocol detail.

### #1247

The issue body contains no description, environment, steps, logs, screenshot, or version.
The only comment repeats that pasted Feishu text has no line breaks, and the maintainer
requested a screenshot that was never supplied.

### #1263

This asks whether project-memory indexing exists; it does not report broken behavior or
describe a bounded requested change.

### #1261

The body is an entirely empty template. An isolated macOS desktop run completed nine
real Bash permission cycles while preserving bottom follow, manual wheel scrolling,
the Latest control, and follow after returning to the bottom. The current MessageList
suite also passes. No recording, exact interaction sequence, window dimensions, tool
expansion state, or diagnostic event identifies a different transition to fix.

### #1268

Supporting Pi, DSH, and other harnesses requires a runtime-driver abstraction, event and
permission translation, alternate session persistence/indexing, capability-gated UI,
packaging, migrations, and deterministic contracts. The issue defines neither a first
harness nor a feature-parity boundary. DSH's current public SDK also lacks key desktop
control capabilities such as cancellation/close, approval round-trips, and protocol
version negotiation. This should be split into an RFC and a single-harness MVP rather
than implemented as a small issue.

### #1260

The report is from v0.5.4 and supplies no provider, response, retry header, log, event ID,
or repeatable steps. Current `main` includes the v0.5.5 truncated-tool watchdog and
correctly transitions a terminal stream error to idle/error. A separate simulated
`429 Retry-After: 3600` does reveal a possible long-wait risk, but the issue contains no
evidence connecting its GLM Coding Plan run to that path, so changing retry policy here
would be speculative.

### #1270

The repository passes the official iLink QR URL through unchanged and the local
wait/expired flow works with a mocked official endpoint. A matching report also exists
against Tencent's official plugin, including terminal QR rendering, which points toward
account eligibility, rollout, risk control, or the phone-side network path. This issue
has no polling result, decoded hostname, prior bot-binding history, screenshot, request
ID, or account/network A/B evidence. Real WeChat authorization was intentionally not
attempted. The repository's older login protocol is an adjacent compatibility gap, but
the same symptom occurs with Tencent's current protocol and therefore cannot be assigned
as this issue's cause.

### #1272

The report has the same `input_json_delta`, `tool_use`, and exact 120-second termination
signature as #1271, with larger delta counts but no distinct trigger or acceptance rule.
It is covered only if the #1271 repair allows continuously progressing input to complete
past the old absolute limit while still terminating a truly stalled/no-stop stream.

### #1274

The title's request is already supported for Bash commits, `/commit`, and
`/commit-push-pr` through the global `~/.claude/settings.json` setting
`{"attribution":{"commit":""}}`. The deprecated `includeCoAuthoredBy: false` also
works. A desktop toggle could improve discoverability, but the issue does not request a
UI and the behavior itself needs no code change.

### #1275

The ten-minute total stream cap is intentionally separate from the idle timer so a
provider cannot keep a response alive forever by dripping events. It is already
overrideable by process environment, but desktop has no dedicated setting. Removing or
resetting the cap on every delta would regress the earlier infinite-drip failure; adding
a persisted UI setting requires product limits and migration work that this issue does
not define.

### #1279

The Anthropic SDK expects a root Base URL and appends `/v1/messages`. The issue's doubled
path is reproduced only when the supplied Base URL already ends in `/v1`; the provider
UI and documentation already say to use the address before `/v1`. Silently stripping
the suffix would break gateways where `/v1` is a legitimate path prefix. A future narrow
UX validation could warn, but the current report does not demonstrate a runtime defect.

### #1281

Deleting an interior message while retaining later turns requires atomic transcript
graph rewriting, `parentUuid` repair, full tool-use/result pairing, compaction-boundary
rules, runtime quiescence, search/index refresh, backup/recovery, and a product decision
between tombstones and physical deletion. Editing only user or assistant text can create
invalid API history. The existing rewind safely removes a suffix; it is not an interior
delete primitive.

### #1285

The external plugin is new, has no CI or established release history, and intercepts all
provider traffic while rewriting provider Base URLs and copying credentials into runtime
state. Listing it as recommended would imply a security endorsement. Its proposed native
two-stage tool policy is not equivalent to existing Tool Search and would require a new
per-turn runtime state machine across retries, resume, compaction, subagents, concurrent
sessions, cache identity, persistence, and UI. No reproducible benchmark is supplied.

### #1286

Telegram has supported `/resume` since June 2026 and its related tests pass. Feishu,
DingTalk, WeChat, and WhatsApp do not expose it. The issue names no platform, so it is
either an already-supported usage question or an all-adapter parity project involving
shared selection state, platform-specific two-level UX, atomic session switching,
expiry/pagination, and security filtering. That is not a very small feature.

### #1284

The report shows a 5,427-message Windows 10 transcript becoming blank only while a task
runs. An isolated macOS UI loaded the same durable row count, held a real permission
request open, and scrolled to the middle and top with painted rows throughout; a very
tall live stream also remained scrollable. No macOS reproduction means the required Bug
gate is not met. Windows DPI/ResizeObserver and spacer painting remain hypotheses, not a
safe fix, until a recording, build/scale/window details, and a sanitized transcript
shape are available.

### #1287

Neither v0.5.5 nor current `main` discards sessions at 30 days. v0.5.5 groups by project
with an expand action; current `main` groups 31-day-and-older sessions under Earlier,
and global search spans history. The real limit is the newest 400 sessions loaded into
the sidebar. Correctly removing that boundary requires offset pagination and load-more
state rather than another limit increase, and the issue provides no session count or
evidence that the 400-item window was reached.

### #1290

Custom models default to 32K with a 64K ceiling, but the existing Settings JSON supports
`{"env":{"CLAUDE_CODE_MAX_OUTPUT_TOKENS":"16384"}}`; the value is preserved through
provider activation and controls Anthropic-compatible requests. OpenAI Chat/Responses
intentionally omit the output limit so the upstream decides. A dedicated per-provider
or per-model field would require schema, persistence, runtime, and UI work, which the
question does not require.

### #1289

The same reporter and environment as #1284 describe message-action copying failing only
while another task runs. In an isolated macOS UI, both user prompts and assistant replies
copied correctly during a 30-second active stream; the same remained true after crossing
the virtualization threshold with 62 turns and scrolling to the earliest mounted rows.
The screenshot does not identify prompt versus reply, whether the button acknowledged
the click, clipboard contents/errors, row count, DPI, or a complete pointer sequence.
Without the required macOS reproduction, changing the `pointerup`/blur/click seam would
be speculative.
