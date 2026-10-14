# 上游合并报告 — upstream v0.7.1 → fork

- **日期**: 2026-10-14
- **分支**: `merge/upstream-v0.7.1`
- **合并对象**: upstream `v0.7.1` (commit `b0ed7f553`, tag `v0.7.1`, 29 个提交)
- **fork 侧**: `0077c5b6` (release: v0.8.6)
- **merge base**: `4fa568462`
- **合并策略**: **以 fork 为主,吸收上游优化;大改子系统以上游为基底回植 fork 定制点**（与前两次合并一致）

## 合并概况

- 合并提交 `4428f3c3c`（双父：`0077c5b6` + `b0ed7f553`），触及 **246** 个文件，+15025/−827。
- 冲突 **49** 个（`git merge-tree --write-tree` 复算），已全部解决：`git diff --diff-filter=U` = 0，全仓无残留 `<<<<<<<` / `>>>>>>>` 标记。
- 合并后跟进 7 个提交（`ab8748ac4`…`a93071240`），均为修复/测试适配，见「跟进提交」。

## 上游 v0.7.1 关键变更与取向

| 上游变更 | 取向 |
| --- | --- |
| #1501 进程回收（closed session 的 CLI/MCP 进程回收，`releaseUserTurnWithoutResult`） | 取上游语义；fork 的 `isManagedProviderEnvKey` 与 Windows Bun 崩溃提示保留 |
| #1506 子代理并发限制 + 迭代器续接 | 取上游；fork 的 stall 看门狗（`createAgentStallTransitionHandler`）重新嫁接到 `agentIterator` 创建处，`registerLocalAgentLifecycle` + `slotTransferred` 保留 |
| #1476 空白 thinking 语义（冷历史合并去重） | 上游语义重新嫁接到 fork 的缓冲 thinking（`appendPendingThinkingDelta`/`flushPendingThinkingDelta`）flush 循环 |
| #1482 自动更新开关（deferral 尊重） | 取上游 `isUpdateAvailable` 检查 + fork `isNewerVersion` 比较合并；AboutSettings 用 Switch 组件承载 |
| #1505 CSV/TSV 预览、#1493 搜索索引 worker、#1498 实时转录、#1503/#1480 性能、#1502 Fast mode | 整体取上游；Fast mode 的 `openAIFastMode` 贯通到 fork 的 side-chat 守卫与 RuntimeOverride |
| #1513/#1514 会话标签条/侧聊（后经上游 revert） | 跟随上游 revert，fork 的 TabBar 双箭头 + 滚轮行为保留 |

## fork 定制点保护清单（对照 CLAUDE.md,均已确认保留）

- README.md / README.zh-CN.md:与基线 diff 为空,Code Council 品牌与链接完整。
- Provider preset:`teamorouter` / `xuanshuapi`(玄枢) / `fennoai` / `qiniuai` 保留 `deprecated` 墓碑;`jiekouai`(接口AI)可选、无广告。18 个 preset 两侧零增删。
- `xhigh` 推理档:`modelReasoning.ts` 与基线逐字节相同,`kimi-k3` profile 带 `xhigh_effort`;ModelSelector/ReasoningEffortPopover 测试全绿。
- relay 重试 `withRetry.ts`:`get_channel_failed` / `api_error` 5xx 保留(diff 纯增量——上游 `ApiAttemptBudget` 嫁接在旁)。
- `thinking` 透传:proxy 层零 diff,`roundTripReasoningContent` 无条件透传保留。
- Code Council wordmark:`Sidebar.tsx:1125` / `AppShell.tsx` 保留。
- 全库 GitHub 链接指向 `706412584/cc-haha`(README.en.md 新增的一行是上游 AtomGit 致谢,上游自有文件)。

## 冲突解决明细（49 个）

按取向分类:

| 取向 | 代表文件 |
| --- | --- |
| 整体取 fork | `desktop/src/pages/settings/ProviderSettings.test.tsx`、`scripts/pr/run-swift-checks.ts`（fork 侧带 `home` 隔离） |
| 整体取上游 | `.github/workflows/pr-quality.yml`、`src/server/api/teams.ts`、`src/server/ws/events.ts` |
| 手工混合 | `src/server/services/conversationService.ts`、`src/server/ws/handler.ts`、`src/tools/AgentTool/AgentTool.tsx`、`src/services/api/withRetry.ts`、`src/services/api/streamRetry.ts`、`src/services/compact/compact.ts`、`desktop/src/stores/chatStore.ts`、`desktop/electron/services/updater.ts`、`src/server/services/localIndex/*`、5 个 i18n locale |
| modify/delete | `searchContentCommitWorker.ts`(+test):fork 已删(投影器架构),**不复活**;上游对该文件的修改弃用 |

### 关键决策

1. **localIndex schema**:fork `SCHEMA_V7`=`is_team_worker` 保留,上游 `openai_fast_mode` 提升为 `SCHEMA_V8`,`LOCAL_INDEX_SCHEMA_VERSION=8`,按列守卫迁移。`sessionProjector.ts` 的 upsert 19 列 ↔ 19 占位符 ↔ 19 值,三处对齐（见跟进提交 `dfe27d642`）。
2. **chatStore 缓冲 thinking**:fork 的 `appendPendingThinkingDelta`/`flushPendingThinkingDelta` 保留,上游 #1476 的空白增量语义嫁接到 flush 循环（`!segment.text.trim() && (segment.wholeBlock || last?.type !== 'thinking')` 跳过）。
3. **conversationService 停止路径**:修复为直接 `session.proc.kill(signal)`（上游 #1501 语义;Windows 进程树停止在 `killProcess` 中先行）。此修复同时解决了 fork HEAD 上已存在、被上游新测试套件暴露的 `sync is not defined` 缺陷（跟进提交 `ab8748ac4`,生命周期测试 9/9）。
4. **AgentTool 后台转移**:采用上游 #1506 的 `let result = await nextMessagePromise; while (!result.done)` 续接（不重启 worker、不丢已发出的 next）;fork 的 stall 看门狗与 `registerLocalAgentLifecycle` 回植。

## 跟进提交（合并提交之后）

| 提交 | 内容 |
| --- | --- |
| `ab8748ac4` | 修复 v0.7.1 合并遗留的半合并停止路径（`signalProcess` / `session.proc.kill`） |
| `17b1ce3ee` | swift 测试:locked fixture 树只建一次（两次 run 调用） |
| `27399b19b` | chatStore 测试适配 fork 缓冲 thinking（显式 `flushThinking`;OAuth Fast requestId） |
| `c139268a6` | TabBar 两个上游用例补 `unifiedActivityPanelEnabled` 门控 |
| `45adb0076` | updater 恢复合并丢失的 2 个测试（proxy/differential）+ TS6133 导入 |
| `dfe27d642` | sessionProjector 占位符 18→19 + database.test v6 缓存断言补 `openai_fast_mode: null` |
| `a93071240` | 并发测试关闭 fork 独有 invocation limiter（cap=8 被多用例累积触发,见「验证」） |

## 验证

### 符号审计（双向）

- 上游 105 个新符号:0 缺失。fork 1075 个符号:0 缺失。
- 文件删除:0（基线 5936 个文件全在）。
- i18n key:0 丢失（en/zh/zh-TW/jp/kr 各 ≈4400 key）。`data-testid`:0 丢失（468→472）。

### 测试

- **desktop `tsc -b`**:exit 0。
- **desktop 套件**:与基线逐项对照,无新增失败（WorkspaceEditor 10 失败、pets 1 失败为预存）。
- **`check:policy`**:371 pass / 5 fail——全部为已知环境类（symlink EPERM ×4、`/tmp` 断言 ×2、change-policy 超时 ×1,后者在基线 `0077c5b6` 上同样超时）。基线为 7 fail,合并后 5 fail。
- **`check:server`**:与基线对照,**合并侧 18 个失败 ⊆ 基线 34 个失败**（`comm -23` 为空,即无合并新增失败）;基线侧的 16 个额外失败多为 Windows 本地环境/资源类。
- **上游 v0.7.1 新增测试文件逐个跑**:26 个中全部单独验证——`AgentTool.concurrency` 51/51、`conversation-service-process-lifecycle` 9/9、`disconnectCleanupBoundaries` 6/6、`runtimeRestartCleanup` 4/4、`sdkSocketRejection` 1/1、`client.stdioCleanup` 12/12、`windowsProcessTree` 6/6、`QueryEngine.localCommand` 8/8、`remoteIO.permanentClose` 2/2 等。仅 3 处红,均在上游干净检出（同一台 Windows 机器）复现相同失败数,为平台差异非合并引入,已登记 `docs/known-pre-existing-test-failures.md`:
  - `print.compaction.test.ts` 3 fail（`bin/claude-haha` 无扩展名 shebang 在 Windows 不能 spawn）
  - `workspaceWatchState.test.ts` 1 fail、`workspaceWatchReconciliation.test.ts` 2 fail（symlink EPERM）
- **`conversationService` 生命周期**:9/9。**localIndex**:42/42。**proxy**:196/196。**withRetry/streamRetry/modelReasoning**:96 pass。**Sidebar**:106 pass。**providerPresets**:9 pass。**auto-question**:21/21。**v0.7.12 修复（unanswered-question deadline）**:逐字节存活,21/21。
- **上游 v0.7.1 新增测试文件（desktop 侧,逐个跑）**:13 个文件全绿——`updaterLifecycle` 3、`App` 2、`ActivityGroup.rerender` 6、`TrajectoryStopButton` 3、`shortcut` 56、`shortcutGesture` 9、`shortcutPreference` 8、`GeneralSettingsPermissionMenu` 1、`GeneralSettingsSubagents` 13、`VoiceShortcutSettings` 9、`hiddenSessionRelease` 13、`settingsStoreSubagents` 27、`assert-windows-icon` 6。

### 挂起排查（AgentTool.concurrency.test.ts）

该上游新测试在合并树上曾挂起（单用例过、多用例连跑挂）。根因:fork 独有的 `invocationLimiter`（上游无此机制）用**模块级 per-session 计数器**,cap=8;每个用例 spawn 3 次,3 个用例连跑累积 9 次触发 cap,被拒的 replacement spawn 抛错 → `replacement.started` 永不 resolve。修复:测试内 `CLAUDE_CODE_AGENT_LIMITER_OFF=1`（fork 已有文档化开关）,槽位用例与调用限流正交。修复后 51/51 全绿 12.04s。

### 独立审核

三次代理审查（与实现者分离）:

1. **冲突解决正确性**（审查 #1）— 见下方独立审核结论。
2. **fork 定制回归检查**（审查 #2,对照 v0.8.6 基线）— **FORK-AUDIT: PASS**。7 个 CLAUDE.md 固定项完整、23 个功能候选完整、0 文件删除、0 i18n/testid/anchor 丢失。附注:上游 AruHub URL 变更为上游自身提交;README.en.md 的 AtomGit 行同上。
3. **最终 diff + 构建/测试终审**（审查 #3）— 见下方独立审核结论。

## 残余风险

- **本机 `check:server` 退出码不可用**（Windows EBUSY,基线同红,见已知失败清单）;本轮以「基线失败集合 ⊆」比对 + 上游新增测试逐个跑补齐覆盖。CI(Linux) 为最终权威。
- **`src/` 无独立类型检查 lane**（既有问题）;root 改动由测试验证。
- **上游新增测试的 Windows 平台差异已登记**（print.compaction / workspaceWatch 系列）;CI 上需确认其绿。

## 独立审核结论

_由独立子代理产出（与实现者分离）。_

（待审查 #1 / #3 返回后补录。）
