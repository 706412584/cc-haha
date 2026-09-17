# 已知预存测试失败清单（Pre-existing Test Failures）

> 用途：这些测试在**本地/CI 上早已失败**，与任何单次上游合并无关。每次合并上游后如果遇到下面列出的失败，**先对照本清单**：只要红的还是这些、没有新增，就是预存问题、不是本次合并引入的，可放行。只有出现**清单之外的新失败**才需要排查。

> 验证方法：在 pre-merge 基线（合并 commit 的第一父，`git worktree add <tmp> <first-parent> --detach`）上重跑同一批测试。若基线同样红 → 预存。

最后核对日期：2026-09-16（合并上游 v0.6.3）。

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

### 端口竞争型 flaky（`check:server` 偶发）

- `src/server/__tests__/diagnostics-service.test.ts > DiagnosticsService > keeps fatal startup errors visible on stderr while recording diagnostics`
  - **现象**：断言 `stderr` 含 `Failed to start server. Is port <N> in use?`，实际收到 `[Server] Uncaught exception:\nError\n at startServer (src/server/index.ts:549:30)` —— 错误对象存在但 `message` 为空，于是 `index.ts:545` 走了 `error.message` 分支而非端口 fallback。
  - **判定**：测试启动第二个 server 进程抢占同一端口，属环境时序竞争。**同一 commit 上重跑即通过**（2026-09-14：`server-checks` 首跑红、`gh run rerun --failed` 后 pass），本地单跑 38 pass / 0 fail。
  - **与本仓库改动无关**：该文件在 pre-merge 基线（`6bf0932a`）即存在，本次合并与上游 v0.6.2 均未触及它（`git diff` 为空）。
  - **处置**：重跑该 job，无需改代码。

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

## 上游 v0.6.3 新增文件在 Windows 本地的失败（非本次合并引入）

`src/server/services/reviewService.test.ts`（13 fail / 58 pass）与
`src/server/services/workspaceWatch.test.ts`（2 fail / 8 pass）是 v0.6.3 **新引入**的文件。
已在上游源码（`3e160f7e` worktree）上原样复现同一组红，且这两个测试文件与其实现文件与本仓库逐字节相同 ——
即上游自己在这台 Windows 机器上就是红的，与 fork 的合并无关。

- **符号链接类**（reviewService 4 个 + workspaceWatch 1 个）：Windows 创建 symlink 需要管理员权限，报 `EPERM: operation not permitted, symlink`。CI(Linux/macOS) 无此限制。
- **Git 行为类**（reviewService 9 个）：`core.autocrlf=true` 是本机系统级 git 配置（`D:/360downloads/Git/etc/gitconfig`），
  会让测试里 `git checkout` / `git apply` 的往返把 LF 换成 CRLF，断言的字节内容因此不匹配；
  另有以 `:` 开头的 pathspec magic、带空格/反斜杠/换行的文件名，属 Git for Windows 的路径处理差异。
  **验证**：`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false bun test src/server/services/reviewService.test.ts`
  可把 13 fail 降到 9 fail，剩下的仍是符号链接与 Windows 文件名限制。
- **fs.watch 时序类**（workspaceWatch 1 个）：`Timed out waiting for filesystem event` —— Windows 的 ReadDirectoryChangesW 与测试的 2s 预算竞争。

结论：这 15 个红在上游同样存在，不是合并回归。若要本地跑绿，只能改测试（加 autocrlf 关闭、symlink 跳过），
但那会把上游文件改得与上游不一致，故不改。

## `check:bundle-budget`（desktop）—— 基线已过期，非本次合并引入

`desktop/scripts/check-bundle-budget.ts` 里的 `BASELINE_GZIP_BYTES`（3_707_686，即 3620.79 KB gz）
标注为「Captured 2026-07-14 on origin/main @ 2a44f381」，对应 fork v0.5.38 时期。

实测：

| 版本 | dist/assets 总 gzip |
| --- | --- |
| pre-merge 基线（`8f526396` = fork v0.6.4） | 4757.37 KB |
| 本次合并后 | 4854.00 KB |

即**在合并前的基线上该门禁就已经红了**（超出 ceiling 1036.58 KB），本次合并自身只增加
96.63 KB（+2.0%）。根因是常量长期未随 fork 的功能增长更新，而不是某次改动超预算。

该脚本**未被任何 CI workflow 调用**（`grep -rn "bundle-budget" .github/` 为空），只存在于 `desktop/package.json`
的 scripts 里，属手动门禁。故它不会挡 CI。

**处置**：不改常量。把阈值调高会把「超预算」从可见的红变成静默通过，而是否接受这 ~1 MB 的增长
（很大一部分来自 xterm / shiki / katex / cytoscape 等按需加载的第三方 chunk）应由维护者决定，
不应由合并顺手改掉。若决定接受，应连同「为什么这些 chunk 该留在预算内」一起更新注释再提交。

## adapters（`bun test`，Windows 本地）

- `common/__tests__/chat-runtime.test.ts > ImChatRuntime server stream > uploads an image referenced in the stream and skips one outside the work dir`
  — 断言 `images` 恰好为 `[{ mime: 'image/png', alt: 'inside' }]`，实际多出一项（`/etc/hosts` 的越界路径未被跳过）。
  该用例最后一次改动是 `59c7857b`（2026-09-08，fork v0.6.4 之前），**是合并基线的祖先**；且本次合并对 `adapters/` 的改动为空
  （`git diff 8f526396 HEAD -- adapters/` 无输出）。属预存失败，稳定复现（单跑 34 pass / 1 fail，两次一致），非 flaky。

  其余 749 pass / 1 skip。CI 的 `check:adapters` 若红，先对照此项。

## 未接线的功能：`workspace.file.saved` → `applyExternalSave`（预存，非测试失败）

不是测试红，但独立审查时发现的一处**功能死代码**，记在这里以免下次又当成新发现。

- 服务端 `src/server/services/workspaceFileService.ts:311` 在保存成功后 `emitWorkspaceFileSaved({ source: 'user' })`，
  其注释明确写着「so the desktop conflict-banner contract holds」。
- 但**桌面端没有任何模块订阅这个事件**：`grep -rn "file.saved" desktop/src/` 为空（`8f526396` 基线上同样为空）。
- 因此 `useWorkspaceEditorStore.applyExternalSave` 与 `WorkspaceEditor` 里那段外部 rebase 效果**只能由测试触达**。

**判定为预存**：合并前的 `workspacePanelStore.applyExternalSave` 同样只有测试调用方
（`git grep -n applyExternalSave 8f526396 -- desktop/src` 除定义外只命中测试与一处注释）。
本次合并与重移植都没有删掉过订阅者——它从来就不存在。

**影响**：「另一个窗口保存了同一文件」这一冲突分支（`source: 'user'`）永远不会触发。
Agent 写入的分支（`source: 'agent'`）走的是 chatStore 的工具流，与这条无关，已修复可用。

**处置**：不属本次合并范围，未改动。若要做，正确做法是在桌面端的 WS 消息分发里接上
`workspace.file.saved`，按 `sessionId` + 路径调用 `applyExternalSave`（缓冲键为 `sessionId::path`，
服务端事件里的路径需要先归一化到工作区相对路径）。同时应给服务端那行注释与实现二选一地对齐。
## Bun 的 `fs.watch` 不报告 rename 目标（跨平台，非本仓库缺陷）

`src/server/services/workspaceWatch.test.ts > coalesces real writes and renames in subscribed directories and cancels cleanly`
曾断言 rename 后能收到 `src/b.ts`，在 Linux CI 与 Windows 本地都会超时。

**根因已定位到运行时，不在产品代码**：

| 层面 | 是否报告 rename 目标 `b.ts` |
| --- | --- |
| 内核 inotify（`IN_MOVED_TO`） | ✅ 报告（WSL/Ubuntu 24.04 上用 ctypes 直接验证：`[('0x40','a.ts'), ('0x80','b.ts')]`） |
| Bun 1.3.14 的 `fs.watch` | ❌ 只报源文件（`RAW: ["rename:a.ts"]`） |
| `WorkspaceService.watchDirectories` | ✅ 逻辑正确——同样路径用普通 create 能正常上报 `src/b.ts` |

Bun 的 `fs.watch` 在 Linux 与 Windows 上都把 rename 的目标事件丢掉了（Windows 侧另经独立排查确认同样如此）。

**处置**：已把断言改为等待 rename **源**（`src/a.ts`），并另断言目标文件确实存在（证明移动发生），同时保留该用例原本验证的合并、去重、取消语义。超时预算也从 2s 放宽到 5s（CI 负载下 inotify 可能延迟，而这用例测的是语义不是延迟）。

**对真实用户的影响**：很小。编辑器保存是「写临时文件 + rename 覆盖」，Bun 会报告被覆盖的那个名字；只有对已打开文件做纯 rename（如 agent 执行 `mv`）时，事件呈删除形状，文件被当作删除而非重命名——表现不精确，但不会漏刷新。

**本机验证**：WSL Ubuntu 24.04 + bun 1.3.14（与 CI 同代）跑 `workspaceWatch.test.ts` 为 10 pass / 0 fail；Windows 本地 9 pass / 1 fail，剩的那个是 symlink `EPERM`（需管理员权限），CI 上通过。

## quarantine 已登记项

见 `scripts/quality-gate/quarantine.json`。仅对**整文件基本全红且属确定性架构分歧**的登记（避免连带停掉大量通过的测试而丢覆盖）：
- `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`（2 pass / 2 fail，ownership 架构分歧）
- `src/utils/noKeyValueNudges.test.ts`（0 pass / 1 fail，架构分歧）

「1 红 55 绿」类文件（agentToolUtils、tasks、ws-memory-events 等）**不 quarantine**——不值当丢覆盖，靠本清单记录即可。
