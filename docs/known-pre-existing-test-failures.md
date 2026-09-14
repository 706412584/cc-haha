# 已知预存测试失败清单（Pre-existing Test Failures）

> 用途：这些测试在**本地/CI 上早已失败**，与任何单次上游合并无关。每次合并上游后如果遇到下面列出的失败，**先对照本清单**：只要红的还是这些、没有新增，就是预存问题、不是本次合并引入的，可放行。只有出现**清单之外的新失败**才需要排查。

> 验证方法：在 pre-merge 基线（合并 commit 的第一父，`git worktree add <tmp> <first-parent> --detach`）上重跑同一批测试。若基线同样红 → 预存。

最后核对日期：2026-09-14（合并上游 v0.6.2）。

---

## 根因 A：`agentCompletionInbox` 架构 vs 测试的 command-queue 断言

fork 之前把后台 agent 的完成通知从「完成即直塞命令队列」重构成了 **`agentCompletionInbox`**（持久化收件箱 + `delivery` 追踪 + ack 后才 drain 进命令队列）。引入该架构的 commit（`f4ded351 preserve pending completion delivery`、`d40cb40c retain agent completions until acknowledgement`、`2f797500 retain queued completion ownership` 等）**没有同步更新**下列测试，它们仍断言 `getCommandQueue()` 里直接出现带 `agentId` 的通知（上游行为）。

因此这些测试**从 inbox 架构落地起就一直红**，只是 `main` 分支只触发 Deploy React Site、从不跑 `check:server`，所以从没在 CI 暴露；只有 PR 才跑 PR Quality 门禁。

**注意**：修复方向是把这些测试改写成 inbox 架构断言（断 `agentCompletionInbox` / drain 后队列），**不是**回退 inbox 架构——那是 fork 刻意做的持久化/ack 加固。

受影响测试（`check:server`）：
- `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`
  - `enqueueAgentNotification ownership > keeps a root agent terminal notification on the main-thread path`
  - `enqueueAgentNotification ownership > routes a nested terminal to its parent and emits owned SDK metadata`
- `src/tools/AgentTool/agentToolUtils.test.ts`
  - `runAsyncAgentLifecycle > keeps start, progress, and terminal owned when root resumes a nested run`
- `src/tools/TaskTools.eager.test.ts`
  - `Task tool execution ordering > advances the persistent task revision only for real list mutations`
- `src/server/__tests__/tasks.test.ts`
  - `Tasks API > should wait for an in-flight task update before deleting it`
  - `Tasks API > should reject invalid or oversized reset snapshots`
- `src/server/__tests__/sessions.test.ts`
  - `Sessions API > POST .../subagents/by-tool/:toolUseId/messages should resume the resolved agent`
  - `Sessions API > POST .../subagents/by-tool/:toolUseId/messages should reuse a running parent CLI`
- `src/utils/noKeyValueNudges.test.ts`
  - `model-facing nudges ... > does not inject verification reminders based on edit or task counts`

**已部分修复（v0.5.64）**：`enqueueAgentNotification` 现在会为 owner-scoped（nested）终态发出带 `owner_agent_id` 的 `task_notification` SDK 事件（此前完全没发，是真实行为缺失）。但命令队列断言仍不匹配 inbox 架构，故上列测试仍红。

## 根因 B：跨文件共享状态污染（仅全量运行时红）

下列测试**单独跑时通过**，只在 `check:server` 全量并发跑时红——属测试隔离/顺序问题，非确定性 bug：
- `src/server/__tests__/teams.test.ts`（单跑 92 pass / 0 fail）
- `src/server/__tests__/ws-memory-events.test.ts > WebSocket memory events > forwards nested task ownership without marking the main turn as tool executing`（与根因 A 同源的 ownership 断言）
- `src/utils/swarm/inProcessRunner.test.ts`（单跑 23 pass / 0 fail）

## 根因 C：Windows 环境限制（路径/符号链接/长度）

- `src/utils/workflows/save.test.ts > refuses when the project .claude directory is itself a symlink` — Windows `symlink` 需要管理员权限，本地报 `EPERM`。
- `src/server/__tests__/sessions.test.ts` 中可能与路径规范化/长度相关的用例（`branch name past the length cap`、`rewind ... unsafe tracked paths`、`turn-checkpoints ... canonical path`）— 在 CI(Linux) 与本地(Windows) 表现可能不同，逐项以基线对照为准。
- `src/server/__tests__/workflows-api.test.ts > Workflows API > refuses to write through a symlinked target` — 同上，Windows `symlink` EPERM。
- `src/server/__tests__/session-protocol-rollback.test.ts` 的 WebSocket 用例 — sandbox `cleanup()` 的 `rmSync` 撞上刚 kill 的子进程句柄，Windows 报 `EBUSY`（与下方 `claudeBetas` 同源）。
- `src/server/__tests__/skills.test.ts > commands that exist only inside the binary > still lists bundled skills when nobody has signed in` — 子进程探针在 Windows 上无 stdout 输出，`JSON.parse` 拿到空串。
- `src/server/__tests__/conversation-service.test.ts > buildChildEnv flushes desktop transcripts before the SDK reports turn completion (#1033)` — `nonSdkEnv.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 在 Windows 本地为 `'1'`；基线（`6bf0932a`）同样红。
- `src/server/services/macAppIcon.test.ts`（7 个）与 `src/server/__tests__/mac-installed-apps.test.ts`（5 个）— macOS 专属（`sips`/`/usr/bin`/app bundle 枚举），Windows 本地全红；基线同样红。
- `scripts/quality-gate/package-smoke/index.test.ts > final macOS helper cursor resource verification`（4 个）— 上游 v0.6.2 新增的 cursor 资源用例。Windows 本地红的两类原因：(1) `executes the {arm64,x64} final helper...` 断言命令路径含 `Relocated Helper.app/Contents/MacOS/...`，但 Windows 的 `join()` 产出反斜杠；(2) `rejects a final package with {external,external-frame}-symlink...` 需 `symlinkSync`，Windows 无管理员权限报 `EPERM`。CI(Linux/macOS) 上应通过。
  > 注（2026-09-14）：该 describe 的 `fixture()` 未写入 fork 要求的 `plugin-seed/.../marketplace.json`，导致**额外** 2 个 `records a skipped execution...` 用例因 fork 的 plugin-seed presence check 变红。已在 fixture 中补上该文件（fork 的检查本身是有效不变量，不应放宽）。
- `scripts/pr/change-policy.test.ts > evaluateChangePolicy > plan-only mode publishes a blocked scope without preventing product jobs` — 用 `Bun.spawn` 起子进程跑 `change-policy.ts`，在 Windows 本地超 5s 未返回而 timeout；基线（`6bf0932a`）同样红。手动直接执行该脚本本身正常。

## 上游新增、上游 CI 从未执行过的 GUI 集成测试（`macos-swift-checks`）

> **与上文「预存」的区别**：下面这条**不在** pre-merge 基线上（基线没有这个测试），所以基线对照法不适用。它的性质是「上游新加、且上游从未在 CI 上执行过的测试，其自身的前台时序假设在共享 runner 上不成立」——不是我们的回归，也不能靠基线对照证明。

### `testVisibleCursorSurvivesRepeatedClicksAndTracksExposedBackgroundWindow`

- **位置**：`native/cu-helper/Tests/CuHelperTests/AXTreePublicationIntegrationTests.swift`（引入于上游 `0bcbfe69`，2026-09-11）
- **失败**：`ForegroundLease.swift:417` — `[focus_changed] The target lost focus while preparing input.`
- **归因证据**：
  - v0.6.1(`7b80cef4`)→v0.6.2(`85e7f3a2`) 该文件**只新增这一个** `func test`（6 → 7）；PR #156(v0.6.1) 的 `macos-swift-checks` **success**，PR #157(v0.6.2) **fail**。
  - 四次独立 CI 运行（`103829173862`/`103852529671`/`103865067520`/`103929445217`）同测试、同错误、同行号 —— **确定性失败**，非 flaky。
  - 同 suite 另 6 个测试全部通过，只有它失败。
  - **与 fork 无关**：`native/` 与上游 v0.6.2 逐字节相同；`scripts/pr/run-swift-checks.ts` 未改；`macos-swift-checks` job 定义与上游逐字相同（workflow 的差异全在 Linux job 的 ripgrep 安装，与此 job 无关）。
- **runner 能力已取证（先前的「无 GUI 会话」猜测已证伪）**：runner 为 `macos-26-arm64`（macOS 26.6.2），**有** GUI 会话——四条证据：(1) 日志中 `XCTSkip`/`Skipped` 计数为 0，权限检查（Accessibility + Screen Recording）通过；(2) `Timed out waiting` 计数为 0，`waitUntil("disposable receiver is foreground")` 成功；(3) 同 suite 其余 6 个需要 WindowServer/AX 的 GUI 测试全部通过；(4) 失败形态是 `focus_changed` **抛错**而非等待超时。
- **实际机制：焦点代际竞态（已定位到代码）**：`SyntheticWindowFocus.swift:113` 的 `confirm()` 要求 `belief.generation == generation`，而 `observeFocus(hasFocus: false)`(:104) 与 `observeFrontmost()`(:89，由 `NSWorkspace.didActivateApplicationNotification`:214 驱动) 都会 `generation &+= 1`。测试自身在 `verifyVisibleClicks` 里调用 `app.activate(ignoringOtherApps: true)`(:518) 把**测试进程**设为前台，同时又要求 **fixture 进程**(`pid`)持有输入焦点 —— 两个进程争同一个「前台」状态，激活通知在建立焦点期间递增 generation，`confirm()` 于是返回 false。该分支是此测试独有；其余 6 个测试从不切换前台。失败用时 3.344s（通过的同类测试 3–5s），调用点在 `verifyPublishedControl` 完成一次 `Bold` 点击之后(:280)，即 click 循环早期。
- **上游从未验证过它**：三个 swift=success 的 run（`34139498857`/`34138429173`/`34138137420`）都在 2026-09-07，而该测试 09-11 才引入；用 `git show <sha>:<file> | grep -c testVisibleCursorSurvives` 证实这些 SHA 中计数为 0。该测试引入后，上游仅两次 PR Quality run，`macos-swift-checks` 均 **skipped**（只改 docs）。
- **仍未证实**：该测试在上游开发者的本机环境是否能稳定通过，无从取证（无执行记录）。机制上它依赖「测试进程与 fixture 进程的前台切换时序」，单用户本机窗口更宽，CI 上更窄。
- **处置**：按已知失败放行，合并后单独处理。候选方向：(a) 改测试，使 `verifyVisibleClicks` 不同时要求两个进程前台（如用 `orderFrontRegardless` 替代 `activate`）；(b) 按上游语义补 skip 条件。**不要**放宽 `confirm()` 的 generation 判定——那是真实的焦点竞态防护。

## desktop（vitest，`desktop-checks`）——quarantine 覆盖不到

`quarantine.json` 只作用于 `check:server`，**不覆盖 desktop vitest**。下列 desktop 测试在 pre-merge 基线同样全红，属预存：
- `src/components/settings/AgentManager.test.tsx`（6 个）:
  `keeps the override modal open when saving fails` / `preserves a saved model ID that the current provider no longer lists` / `sends explicit nulls when an editable agent returns to inherited defaults` / `sends inherit as a real value when the user picks it` / `separates the built-in default from inherit and sends null for the default` / `uses the shared project picker even when there is no active project`
- `src/components/layout/TabBar.test.tsx`（4 个）:
  `hides the activity button for team member transcript sessions` / `keeps an owned Team DAG, roster, and member spawn out of Activity while preserving a direct SubAgent` / `keeps the activity button available for a persisted workflow-only run` / `routes Agent Teams tasks to the workbench while keeping lead TodoWrite activity`
- `src/components/controls/ModelSelector.test.tsx`（1 个）:
  `uses caller-supplied models in the reusable field appearance`
- `src/pages/EmptySession.test.tsx`（1 个）:
  `materializes the resolved Claude OAuth model before the first draft message`

  > 注（2026-09-12）：同文件的 `materializes raw provider models with 1M=true/false before the first draft message`
  > 两个用例已按 fork 行为适配（`set_runtime_config` 带 `requestId`；`set_coordinator_mode` 重放插在
  > prewarm 与 user_message 之间），不再红。
- `src/components/activity/SessionActivityPanel.test.tsx`（2 个，基线同样红）:
  `labels a cached workflow agent explicitly instead of calling it merely completed` / `renders a workflow as phase headers with their agents, each opening the subagent page`
- `src/components/layout/Sidebar.test.tsx`（多个，基线同样红）— project display-name / repo 上下文相关的一组。

### `claudeBetas.integration.test.ts`（Windows 本地专用，CI 正常）

7 个用例在 **Windows 本地**全部报 `EBUSY: resource busy or locked, rm 'C:\Users\...\cc-haha-context-beta-*'`
（`runRelay` 的 `finally` 里 `rm(sandbox)` 与刚被 `child.kill()` 的 CLI 子进程抢文件句柄）。CI 是 Linux/macOS，
无此句柄竞争，7/7 通过 —— 上面 `check:server` 的红即由此而来，不是断言失败。

本地验证真实行为时，可临时给该 `rm` 加退避重试；加完 7 pass / 0 fail。**不要把这个补丁提交**：
CI 上不需要，且会把「清理失败」从可见的红变成静默重试。

## desktop（vitest）——Windows 环境限制（非 quarantine 覆盖）

下列两个文件与其**全部 import 的源文件**均与 pre-merge 基线（`b28d2fa3`）逐字节相同，desktop 的 vitest 配置也未改动，故与上游合并无关，属 Windows 本地环境限制：

- `scripts/build-macos-arm64.test.ts > installs every package needed by the compiled sidecar in a clean worktree`
  — 测试用 `spawnSync('/bin/bash', ...)` 跑 macOS 构建脚本；Windows 无 `/bin/bash`，`spawnSync` 返回 `status: null`（ENOENT）。CI(Linux/macOS) 上应通过。
- `electron/services/serverRuntime.test.ts > waits for real server shutdown cleanup before the first restart attempt`
  — fixture 子进程依赖 `SIGTERM` handler 延时清理 `active-turn` 文件；Windows 上 `child.kill()` 直接终止进程，handler 不执行，`active-turn` 残留。

## quarantine 已登记项

见 `scripts/quality-gate/quarantine.json`。仅对**整文件基本全红且属确定性架构分歧**的登记（避免连带停掉大量通过的测试而丢覆盖）：
- `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`（2 pass / 2 fail，ownership 架构分歧）
- `src/utils/noKeyValueNudges.test.ts`（0 pass / 1 fail，架构分歧）

「1 红 55 绿」类文件（agentToolUtils、tasks、ws-memory-events 等）**不 quarantine**——不值当丢覆盖，靠本清单记录即可。
