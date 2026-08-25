# 已知预存测试失败清单（Pre-existing Test Failures）

> 用途：这些测试在**本地/CI 上早已失败**，与任何单次上游合并无关。每次合并上游后如果遇到下面列出的失败，**先对照本清单**：只要红的还是这些、没有新增，就是预存问题、不是本次合并引入的，可放行。只有出现**清单之外的新失败**才需要排查。

> 验证方法：在 pre-merge 基线（合并 commit 的第一父，`git worktree add <tmp> <first-parent> --detach`）上重跑同一批测试。若基线同样红 → 预存。

最后核对日期：2026-08-25（合并上游 v0.5.5 → v0.5.64，PR #153）。

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
- `src/components/activity/SessionActivityPanel.test.tsx`（2 个，基线同样红）:
  `labels a cached workflow agent explicitly instead of calling it merely completed` / `renders a workflow as phase headers with their agents, each opening the subagent page`
- `src/components/layout/Sidebar.test.tsx`（多个，基线同样红）— project display-name / repo 上下文相关的一组。

## quarantine 已登记项

见 `scripts/quality-gate/quarantine.json`。仅对**整文件基本全红且属确定性架构分歧**的登记（避免连带停掉大量通过的测试而丢覆盖）：
- `src/tasks/LocalAgentTask/LocalAgentTask.test.ts`（2 pass / 2 fail，ownership 架构分歧）
- `src/utils/noKeyValueNudges.test.ts`（0 pass / 1 fail，架构分歧）

「1 红 55 绿」类文件（agentToolUtils、tasks、ws-memory-events 等）**不 quarantine**——不值当丢覆盖，靠本清单记录即可。
