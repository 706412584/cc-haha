# 上游合并报告 — upstream v0.6.7 → fork

- **日期**: 2026-09-29
- **分支**: `merge/upstream-v0.6.7`
- **合并对象**: upstream `v0.6.7` (commit `c37ab2da`,tag `v0.6.7`)
- **fork 侧**: `601230e0` (release: v0.7.2)
- **merge base**: `2f8d819d` (upstream v0.6.6,上一轮已并入)
- **上游增量**: 62 commits
- **合并提交**: `8c290e60`
- **后续修复提交**: `54954f5e`(desktop 类型错误)、`541d52bf`(desktop 回归)、`6b666b33`(server 回归)、`74748173`(dead-import + compact.test 括号)、`bacb1596`(sessionService 元数据折叠)、`373d0753`(sessionService 单候选短路)、`2bc81c08`(sessionService side-chat 守卫)
- **合并策略**: 以 fork 为主,吸收上游优化;大改子系统以上游为基底回植 fork 定制点

> 为什么合并对象是 tag 而不是 `upstream/main` HEAD:HEAD 比 tag 多 3 个提交。本次按用户指定锁定 tag,保持发布点可复现。

## 合并概况

- 合并提交触及 **580** 个文件(+28534 / −7073)。相对 fork main 的净差为 581 文件(+28595 / −7081,含 6 个修复提交)。
- 冲突 **49** 个,已全部解决(`git diff --diff-filter=U` = 0):47 content、1 add/add、1 modify/delete。
- 全仓无残留 `<<<<<<<` / `>>>>>>>` / `=======` 标记。
- 上游 v0.6.7 的主题:工作区侧边对话(`/btw`)、Agent Teams 启动前人工审核、超时自动回答、聊天外观设置;以及 #1373 超大会话打不开、并发写丢配置、IM 重连串会话等修复。

### 冲突文件按子系统分布

- **desktop**:`chatStore.ts` / `chatStore.test.ts`、`runtimeSelection.ts`、`ModelSelector.tsx`、`ChatInput.tsx`、`MessageList.tsx`、`AssistantMessage.tsx`、`ThinkingBlock.tsx`、`TabBar.tsx`、`ActiveSession.tsx` / `.test.tsx`、`WorkspaceFileTreePane.tsx` / `.test.tsx`、`GeneralSettings.tsx`、`settingsStore.ts`、`types/settings.ts`、`providerStore.test.ts`、`sessionRuntimeStore.test.ts`、5 个 i18n locale、`api/providers.ts`、`package.json`、`AskUserQuestion.test.tsx`、`MessagePayloadRetention.test.tsx`、`generalSettings.test.tsx`
- **server**:`ws/handler.ts`、`services/conversationService.ts`、`services/sessionService.ts`、`services/providerRuntimeEnv.ts`、`services/localIndex/{sessionProjector,transcriptReducer}.ts` 及对应测试、`api/settings.ts`、`__tests__/{conversations,websocket-handler}.test.ts`、`services/sessionReferencesPersistence.test.ts`、`services/localIndex/database.test.ts`
- **shared**:`src/services/compact/compact.test.ts`、`src/services/api/withRetry.test.ts`、`src/tools/TaskUpdateTool/TaskUpdateTool.ts`、`src/server/proxy/transform/openaiChatToAnthropic.ts`
- **其他**:`README.md`、`README.zh-CN.md`(按规则保留 fork 侧)、`release-notes/v0.6.7.md`、`site/vite.config.js`、`site/src/pages/home/HomePage.jsx`(modify/delete,保留 fork 版本)

## 关键架构决策(二选一/取舍)

1. **会话历史 / 本地索引迁移** → 取上游 `is_team_worker` 列,但**不能直接用上游的版本号**。fork 与上游在 v4–v6 上各花了不同的列(fork: `thinking_enabled`、`active_duration_ms`、`session_api_format`;上游: `active_duration_ms`、`session_api_format`、`is_team_worker`),所以一个来自任一支线的缓存都可能报 v6 却缺另一支线的列。处理方式:`is_team_worker` 落在 **v7**(两条支线都空出的第一个号),每个 ALTER 前用 `hasColumn` 守卫使其在任一支线上幂等,并保留 fork 的循环前 v4 修复(上游支线缓存报 v4 但缺 `thinking_enabled`)。详见 `src/server/services/localIndex/migrations.ts:193-300`。
2. **Provider 运行时环境** → 取 fork 的 `readProvidersIndex`(返回整个 index),并**回植上游被丢掉的官方账号分支**:`isOpenAIOfficialProviderId` → `buildOpenAIOfficialRuntimeEnv`、`isGrokOfficialProviderId` → `buildGrokOfficialRuntimeEnv`(`src/server/services/providerRuntimeEnv.ts`)。同时吸收上游的 `officialProviderModels` 归一化与 `fable` 槽位 1M 支持。
3. **`RuntimeOverride` 类型** → 取并集:fork 的 `thinkingEnabled?` / `providerRevision?` + 上游的 `requestedConfig?`。
4. **权限请求重放** → 合并回调里上游新增的 `replayPendingPermissionRequests` 被自动合并丢弃,已回植(`ws/handler.ts`,见下「真实功能回归」)。
5. **`PENDING_PERMISSION_DISCONNECT_CLEANUP_MS`** → 保 fork 的 5 分钟。上游为自动回答把窗口提到 31 分钟,但自动回答默认 `enabled: false`,按 fork 语义取 5 分钟并留注释。
6. **desktop 运行时选择 API** → 合并签名 `resolveActiveProviderRuntimeSelection` / `resolveDefaultRuntimeSelection`,参数放宽为 `ModelInfo | string | null | undefined`,吸收上游的 `configuredModelId` 优先级(`desktop/src/lib/runtimeSelection.ts`)。
7. **`ModelSelector`** → 回植 fork 的 `lockedProviderChoices`(临时侧边对话锁定 provider 时过滤候选)。
8. **`getMaxStreamTransientRetries`** → 取并集:默认保留 fork 的 **4**(relay provider 依赖更宽的恢复窗口,且 fork 另有 `CLAUDE_STREAM_TRANSIENT_RETRY_BUDGET_MS` 墙钟预算兜底),上限吸收上游的 **`Math.min(raw, 5)`**(防环境变量误配成无界重试)。

## fork 定制点保护清单(对照 CLAUDE.md,已逐项确认)

| 定制点 | 状态 | 证据 |
| --- | --- | --- |
| README.md / README.zh-CN.md | 未被上游覆盖 | `git diff main -- README.md README.zh-CN.md` 为空;冲突处取 fork 侧 |
| provider preset 墓碑 | 保留 | `providerPresets.json`:teamorouter / xuanshuapi / fennoai / qiniuai 均 `deprecated: true` |
| 接口AI 可选、无广告 | 保留 | `jiekouai` 记录无 `deprecated`、无 `featured`/`promoText`/推荐码 |
| `xhigh` 推理档 | 保留 | `src/commands/effort/effort.tsx`、`agentFileUtils`、`controlSchemas.effort` 等多处 |
| relay 重试逻辑 | 保留 | `src/services/api/withRetry.ts:273,277,289,990`(`get_channel_failed` / `api_error` / 结构化 body 匹配) |
| `thinking` 透传 | 保留 | `src/server/proxy/handler.ts:873-874` 无条件透传,未按 reasoning profile 条件化 |
| Code Council wordmark | 保留 | `desktop/src/components/layout/Sidebar.tsx:1194`(`Code <span>Council</span>`)、`AppShell.tsx:426` |
| GitHub 链接指向 706412584/cc-haha | 保留 | `README.md:158` / `README.zh-CN.md:157` 的 `anthropics/claude-code` 是上游项目署名,非本仓库链接 |

## 真实功能回归(合并静默丢失 fork 逻辑,共 9 处,均已修复)

这一节是本次合并最重要的部分。九处丢失**都没有产生冲突、没有类型错误**,与 v0.6.6 报告记录的失效模式完全一致。分三批发现:第 1–4 处在合并过程中由逐文件复查发现,第 5–8 处由独立审核代理复查发现(见下「独立审核结论」),第 9 处由「跑完整 server lane」发现(见「验证结果 → check:server」)。其中第 6、7、8、9 处本会表现为「上游新增测试失败」,但因基线清单不含这些新文件而完全隐形(详见本节末尾)。

### 第一批(合并过程中发现)

1. **`ws/handler.ts` — `replayPendingPermissionRequests` 丢失。** 合并后的 `bindClientSessionOutput` 内联 `forward` 回调丢了上游 v0.6.7 新增的「leader 回合结束后重放等待中的权限请求」逻辑。后果:leader 回合完成时渲染端提示被清空,而独立 worker 仍在等回答 —— 该提示不再出现,用户看到的是卡住的队友。已回植:`if (serverMsgs.some(msg => msg.type === 'message_complete')) replayPendingPermissionRequests(ws, sessionId)`。由 `websocket-handler.test.ts > restores a waiting teammate permission` 捕获。
2. **`ws/handler.ts` — stale-modelId 守卫口径错误。** fork 的运行时模型 id 带 `[1m]` / `:1m` 后缀,而 provider 的槽位表从不存后缀。守卫直接用原始 id 比较,于是**每一次 1M 选择都被判为过期模型并回退到普通 main 模型**。修复:引入 `baseModelId()` 剥掉后缀再比较。由 `conversations.test.ts` 的 `it.each ... (high, replay=true)` 捕获。
3. **`ws/handler.ts` — `interruptBoundaryPending` 守卫丢失。** fork 用这个闩锁让第二次 Stop 成为 no-op;丢失后重复点击 Stop 会重复发中断。已恢复守卫,并给 leaderless-stop 的中断加上 `!sessionStopRequested.has(sessionId)` 约束(上游新增的「leader 空闲但仍有 worker」撤销路径保留,但不再与闩锁打架)。由 `counts repeated Stop clicks once` 捕获。
4. **`localIndex/migrations.ts` — 版本号冲突 + 重复声明。** 自动合并产生了**两个 `const SCHEMA_V6`**,并且直接采用上游版本号会让 fork 支线缓存误判。已按「关键架构决策 1」重构。

### 第二批(`sessionService.ts`,由独立审核代理发现,提交 `bacb1596` / `373d0753`)

这一批 4 处**全部在同一个文件**,且**全部逃过了所有门禁**——原因见本节末尾。

5. **`sessionService.ts` — `findSessionFiles` 每个匹配被 push 两次。** 合并把上游的单次 `hydratedMatches.push({...match, mtimeMs, hasTranscript})` 与 fork 的单次 `push({...match, mtimeMs})` 叠在一起,变成两次 push(同一 `filePath` 出现两次)。后果:候选列表被撑大,排序结果不稳定。修复:对齐上游,每个匹配 push 一次。`findSessionFilesFromFiles` 有同样的双 push,一并修复。
6. **`sessionService.ts` — `getMetadataProjection` 用错了扫描器(丢掉上游 #1373 修复)。** 合并后该折叠走 fork 的 `streamBoundedHistory(..., { maxRecordBytes: HISTORY_SEMANTIC_RECORD_BYTES })`,它**跳过**超限记录;上游走新的 `sessionMetadataReader.streamSessionMetadata`,**投影**超限记录并返回结构化元数据。后果:超大会话的元数据投影缺字段/计数错位(#1373 的复发)。修复:改调 `streamSessionMetadata`,并把完成判据从 `scan.oversizedRecords === 0` 改为 `scan.omittedRecords === 0`。由 `sessionService.metadata.test.ts`(上游新增,4/4)捕获。
7. **`sessionService.ts` — effort 替换规则被丢弃。** 上游是 `state.effortLevel = resolveSessionEffortLevel(record, state.effortLevel)`;合并取了 fork 侧那行,`resolveSessionEffortLevel` 虽被 import 却在此处没被调用。后果:后续 `session-meta` 带完整运行时选择但无 `effortLevel` 时,上游会清掉继承来的 effort,合并版却永久保留旧值。由 `sessionService.runtimeSelection.test.ts` 的 `a complete built-in runtime selection also clears old effort` 捕获。
8. **`sessionService.ts` — 会话查找退化成「上游成本 + fork 弱读」的坏混合。** 合并后 `findSessionFiles`/`findSessionFilesFromFiles` 的发现循环已经为每个候选读了**超限感知**的 `fileHasConversationTranscript`,随后多候选分支又用 `readJsonlFile` **重读一遍并覆盖**该值;而 `readJsonlFile` 在文件超过 `maxFullJsonlReadBytes` 时只读**尾部窗口**(`readAndParseJsonl` 的 tail 分支),可能整段错过唯一的会话轮次,从而让「worktree 移动留下的占位文件」排到真正的超大 transcript 前面。同时每一次查找都付出了 transcript 解析成本,即使只有一个候选。修复:在保留上游超限感知读取器的前提下,恢复 fork 的「仅在真正有歧义时才读」短路,并去掉冗余重读。由 `sessionService.metadata.test.ts` 的 `a sole oversized legacy turn ... cannot be mistaken for an empty placeholder` 覆盖。

### 第三批(跑完整 server lane 发现,提交 `2bc81c08`)

9. **`sessionService.ts` — 两条 side-chat 守卫被丢。** 上游 v0.6.7 给 `sessionService` 加了 **12** 条 `isSideChatId()` 分支,合并只留了 **10** 条,静默丢掉 `getSessionHistoryPage` 与 `getSessionMessagesWithEvidence` 两条。临时侧边对话(`side-*`)没有 transcript、也不在 `memoryLaunchInfo`/`knownSessionKeys` 里,于是两者都落到 `findSessionFile`(对 `side-*` 直接返回 null)并抛 **404 `Session not found: side-…`**。后果:桌面端每次回复后读 `GET /api/sessions/:id/messages` 与 `turn-checkpoints` 都 404。由上游新增的 e2e `side-chat.test.ts` 在第一个 `GET .../messages` 处捕获(该测试在合并态 3/3 失败,在纯上游 `c37ab2da` 上通过)。修复:逐字回植两条分支;修复后测试主体全过,只剩测试自身 `finally` 的 Windows `EBUSY` 清理(与上游同形)。

**为什么这些逃过了所有门禁:** 第 6–9 处的覆盖测试(`sessionService.metadata.test.ts`、`sessionService.runtimeSelection.test.ts`、e2e `side-chat.test.ts`)都是上游 v0.6.7 **新增**的测试文件,因此既不在 `scripts/quality-gate/quarantine.json`、也不在 `docs/known-pre-existing-test-failures.md` 的任何基线清单里——「与基线一致」的判定对它们**天然为真**。而 `check:server` 在本机又因已登记的 `EBUSY` 整条中止(见「验证结果」),没能把这些新测试跑出来。两件事叠加,使这批回归在本地完全不可见。**教训:合并后必须显式运行「上游新增的测试文件」,不能只比对基线。** 修复后 `sessionService.metadata.test.ts` 4/4、`sessionService.runtimeSelection.test.ts` 7/7、`side-chat.test.ts` 主体全过(合并态分别是 0/4、4/7、0/1;在上游 `c37ab2da` 上均全绿或仅剩 EBUSY)。

### 第四批(冲突面机械审计发现,提交 `f32f4cf3` / 见下)

前三批靠「跑测试」发现,这一批靠**对 49 个冲突文件做机械审计**发现——方法是:用 `git merge-tree --write-tree` 复算两侧自动合并结果,再对每个冲突文件检查「相对 merge base 新增的行,在合并结果里是否还在」。这覆盖了独立审核代理明确标注的**未逐文件检查的 12 个冲突**(`ChatInput.tsx`、`AssistantMessage.tsx`、`ThinkingBlock.tsx`、`MessageList.tsx`、`ActiveSession.tsx`、`TabBar.tsx`、`WorkspaceFileTreePane.tsx`、`GeneralSettings.tsx`、`settingsStore.ts`、`types/settings.ts`、`api/settings.ts`、`providers.ts`)。

10. **`docs/images/app/**` — 上游删除的截图把 fork README 的引用打断。** 上游 v0.6.7 删除了 10 张应用截图(`composer-mention`、`model-picker`、`pet-desktop`、`session-dark`、`session-permission` × en/zh-CN)。合并接受了删除(改文件名/删文件路径不冲突),但**按规则保留了 fork 的 `README.md` / `README.zh-CN.md`**,而这两个文件仍在引用 `docs/images/app/{zh-CN,en}/model-picker.webp`。后果:CI 的 docs lane(`pr-quality.yml` → `npm --prefix site run check`)在 `check-docs.mjs` 处报 `unresolved image`,**PR 门禁必红**。修复:按「fork 侧优先」恢复这 10 张图。验证:`npm --prefix site run check` 全绿(116 页 / 379 链接 / 26 组双语截图对 / 31 tests)。**教训:modify/delete 冲突里「保留 fork 的 README」蕴含「保留它引用的资源」,资源删除必须一并回退。**

11. **`src/services/api/withRetry.ts` — 上游给 stream 重试上限加的封顶被丢。** 上游 v0.6.7 把 `getMaxStreamTransientRetries()` 的返回值封顶:`Math.min(raw, 5)`。合并取了 fork 侧那一行,只剩 `raw`(默认 4、无上限),于是 `CLAUDE_STREAM_TRANSIENT_RETRY_MAX=1000` 这类误配会变成近乎无界的重试循环。修复:取并集,保留 fork 默认 4、吸收 `Math.min(raw, 5)`(见「关键架构决策 8」)。

12. **冲突测试文件普遍「整文件倒向一侧」,丢掉上游新增用例。** 多个冲突的 `*.test.ts(x)` 直接解析到 fork 侧,于是上游 v0.6.7 新增的用例被静默丢弃(它们不在任何基线清单里,因此红/绿都不会被察觉)。用「测试标题集合差」枚举出 **18 个**被丢用例,逐条判读后**回植 10 个、判为 fork 有意分歧或重复而放弃 8 个**(明细见「验证结果」的「上游新增用例回植」一栏)。**这类丢失不会让任何门禁变红,只会悄悄降低覆盖——正是第 6–9 处能逃过门禁的同一个盲区。**

## desktop 侧修复

- **`chatStore.ts`**:
  - `findCurrentTurnUserMessageIndex` 合并两侧扫描:上游的 outstanding-send 扫描在前,fork 的 image-replay 兜底在后(命中即 early return)。
  - `stopGeneration` 追加上游的 `generationStopped` 系统标记,使用 fork 的 `stoppedDelta`。
  - 恢复 `mapHistoryMessagesToUiMessages` 中 `background_task` 分支被丢掉的 `continue }`。
- **`runtimeSelection.ts`**:参数放宽为 `ModelInfo | string | null | undefined` 并补 `?? null`,消除 TS2345/TS2339。
- **`ModelSelector.tsx`**:回植 `lockedProviderChoices`(见关键架构决策 7)。
- **`ChatInput.tsx`**:`referenceKind` 补 `as const`(TS2322)。
- **测试对齐**:`chatStore.test.ts` 补 `requestId: expect.any(String)` 并改用 `.find()` 定位 `user_message` 帧;`AskUserQuestion.test.tsx` 还原为上游语义(该组件发 `permission_response`,不是 fork 的 `substantiveSends()`);`MessageList.test.tsx` 去掉重复的 `ApiError` import。

## 验证结果

环境:`bun 1.3.14`,node v24.11.0,Windows 本地;`node_modules` 已就位(根 / `desktop` / `adapters`)。

| 检查项 | 结果 | pre-merge 基线 | 判定 |
| --- | --- | --- | --- |
| `tsc --noEmit`(desktop) | **0 错误** | 0 | 通过 |
| `vitest run`(desktop,排除 4 个已登记文件) | 2 failed / 6953 passed | 2 failed(`build-macos-arm64`、`electron/serverRuntime`) | 与基线逐条一致,无新增 |
| `vitest run`(desktop,全量重跑) | 3 failed / 6952 passed | 同上 + `electron/services/shell.test.ts` | 第 3 个为负载抖动,隔离复跑 11/11 通过 |
| `check:policy` | 7 failed / 340 passed | 7 failed | 与基线逐条一致,无新增 |
| site docs lane(`npm --prefix site ci && run build && run check`) | 全绿(116 页 / 379 链接 / 26 组双语截图对 / 31 tests) | 合并态曾红:2 处 `unresolved image` | 修复后通过,见「真实功能回归」第 10 条 |
| `tsc -b` + `vite build`(desktop 生产构建) | 通过(0 错误,build 12.0s) | — | 通过 |
| `check:provider-contract` | 36 suites passed | 全绿 | 通过 |
| `check:chat-contract` | 435 passed(3 files) | 全绿 | 通过 |
| `check:agent-flow` | 8 passed / 0 failed | 全绿 | 通过 |
| `check:adapters` | 1 failed / 782 passed | 1 failed(同一用例) | 预存,无新增 |
| `provider-presets.test.ts` | 19 passed | 全绿 | 通过 |
| `sessionService.metadata.test.ts`(上游新增) | 4 passed | 上游全绿(合并态 0/4) | 修复后通过 |
| `sessionService.runtimeSelection.test.ts`(上游新增) | 7 passed | 上游全绿(合并态 4/7) | 修复后通过 |
| `sessionService.retention` / `local-index-session-parity` / `project-session-history` | 55 passed | 全绿 | 通过 |
| `conversations.test.ts` | 149 passed / 2 failed | 2 failed(RE Pipeline) | 预存,无新增 |
| `check:server`(逐文件跑,587 文件) | 56 非绿 + 1 合并回归(#9,已修) | 两侧 oracle 逐条复现 | 见下 |
| e2e `side-chat.test.ts`(上游新增) | 主体通过(仅剩 EBUSY 清理) | 上游通过(合并态 0/1,404) | 修复后通过 |
| 回植的上游用例(5 个文件) | 全绿:147 + 49 + 34 + 27 + 61 | 合并态曾静默丢弃 | 修复后通过,见下「上游新增用例回植」 |

### 上游新增用例回植(#12 明细)

用「上游与合并态的测试标题集合差」枚举出 18 个被丢用例,逐条判读并实测(每条都在最终态单独跑过):

| 文件 | 用例 | 处置 | 实测 |
| --- | --- | --- | --- |
| `desktop/src/__tests__/generalSettings.test.tsx` | `offers all six palettes…`、`defaults Tool Search off…` | 回植 | 147/147 通过 |
| `desktop/src/pages/ActiveSession.test.tsx` | `keeps the panel open through transient empty states…`、`cancels the pending close…` | 回植 | 49/49 通过 |
| `src/server/__tests__/conversations.test.ts` | `should keep OpenAI-native reasoning controls out of Claude CLI args` | 回植 | 通过 |
| `src/server/services/localIndex/database.test.ts` | `upgrades a frozen v4 cache additively…`、`reopens a frozen v5 cache…` | 回植 | 27/27 通过 |
| `src/services/api/withRetry.test.ts` | `caps overrides so recovery cannot become an unbounded retry loop` | 回植 | 61/61 通过 |
| `src/services/api/withRetry.test.ts` | `does not match a non-APIError` | 放弃(重复) | fork 已将其**改名**为 `does not match an arbitrary non-API error`(同断言),回植会造出重复用例 |
| `src/services/api/withRetry.test.ts` | `defaults to 2 when unset`、`falls back to 2 on non-numeric input` | 放弃(fork 分歧) | fork 默认值有意为 **4**,合并态已有等价的 `defaults to 4…` / `falls back to default 4…` |
| `src/server/__tests__/websocket-handler.test.ts` | 全部 3 个 | 放弃(fork 分歧) | 见下 |
| `desktop/src/components/workbench/WorkspaceFileTreePane.test.tsx` | `closes an old session menu when switching sessions` | 放弃(fork 分歧) | fork main `601230e0` 把菜单抽成 `WorkspaceFileTreeMenu.tsx` 时**删掉了该用例**(merge base `2f8d819d` 尚有、`601230e0` 已无),同时丢了 `useEffect(closeMenu, [closeMenu, sessionId])` 守卫;要过需改非测试源码,超出合并范围 |
| `desktop/src/components/workbench/WorkspaceFileTreePane.test.tsx` | `routes a tree context-menu preview through the pane activation callback` | 放弃(fork 分歧) | fork 的 `WorkspaceFileTreeMenu.tsx:99-104` 从不传 `onPreview`(merge base 也没有),故菜单里没有 `Workspace preview` 项;该文件还 `vi.mock` 掉了 `WorkspaceFileOpenWith`,结构上无法出现该项 |
| `desktop/src/components/workbench/WorkspaceFileTreePane.test.tsx` | `adds a right-clicked file to its own session…`、`supports keyboard invocation…` | 回植 | 34/34 通过 |

**websocket-handler 三个用例为何全放弃(fork 有意分歧):** 其一,fork 的 `isBackgroundTaskAlreadyGoneMessage`(`handler.ts:2732-2741`)把 `Task is not running` / `No task found with ID:` 视为 stop 的**目标状态**,收敛到 `background_task_stopped`,与上游「报失败」的取向相反,fork 自身另有锁定该行为的用例。其二,fork 用 `SESSION_TURN_ACTIVE` **串行化**回合(上游无此机制,改用 `activeUserTurns` 让新回合**取代**旧回合),上游那个「旧失败 handler 不得清掉新活动回合」的用例建立在取代模型上,采纳即需替换 fork 的串行模型。两者都超出合并范围。

**基线对照法**:desktop 的 2 个失败是文档已登记的 Windows 环境限制(`scripts/build-macos-arm64.test.ts` 用 `spawnSync('/bin/bash')`,Windows 无 `/bin/bash` → `status: null`;`electron/services/serverRuntime.test.ts` 依赖 `SIGTERM` handler 延时清理,Windows `child.kill()` 直接终止进程)。adapters 的 1 个(`ImChatRuntime server stream > uploads an image ...`)在 fork main `601230e0` 上以完全相同的形式失败。

desktop 全量重跑时多出的第 3 个失败 `electron/services/shell.test.ts > reveals session and output files without allowing the system to open them`(`Test timed out in 5000ms`,`shell.test.ts:131`)是**负载抖动**,非回归:两次跑法的用例总数相同(6955),隔离复跑该文件 11/11 通过。CI(Linux)以登记基线为准。

`check:policy` 的 7 个失败全部为已登记项:`computer-use live smoke path confinement`(2,`/tmp` 路径假设)、`final macOS helper cursor resource verification`(4,Windows 反斜杠 + symlink EPERM)、`change-policy plan-only`(1,Windows `Bun.spawn` 超 5s)。

### `check:server`

本轮 `check:server` 在 Windows 本地两次都因**已登记的脚手架 `EBUSY`** 中止:测试脚手架 `finally` 里裸调 `rmSync(sandboxHome, { recursive: true, force: true })`,撞上刚被 kill 的子进程句柄(`claudeBetas.integration.test.ts:126`、`scripts/pr/run-server-tests.ts:126`)。这与 `docs/known-pre-existing-test-failures.md` 中登记的 `claudeBetas` / `session-protocol-rollback` 现象同源,属 Windows 本地限制,**以 CI(Linux) 结果为准**。

**基线对照(已实测)**:在 fork main `601230e0` 上跑同一条 `check:server`,**以完全相同的方式中止** —— 同一个文件 `claudeBetas.integration.test.ts`、同一个 `EBUSY`、同样 `error: script "check:server" exited with code 1`。故该中止**不是本次合并引入**,且该文件与 fork main 逐字节相同(合并未改动它)。风险最高的 server 用例已在开发过程中单独跑过并与基线对齐:`conversations.test.ts`、`websocket-handler.test.ts`、`localIndex/database.test.ts`、`compact.test.ts`(14 pass)、`dead-imports.test.ts`(28 pass)。

**关键补验(本轮完成)**:`check:server` 的退出码在本机不可用(见上),但**其「逐文件隔离 + 汇总」的跑法本身可用**。本轮把 `scripts/pr/run-server-tests.ts` 复制成临时脚本、只把 `finally` 里的 `rmSync(sandboxHome)` 包一层 try/catch(绕开第二个 EBUSY 中止点),然后**对全部 587 个 `src/**/*.test.ts`(已扣除 quarantine 8 项)逐文件跑了一遍**。结果:

| 范围 | 结果 |
| --- | --- |
| 合并改动的 server 测试文件(95 个) | 2010 tests,32 fail —— 逐条归因后**全部为预存** |
| 其余 server 测试文件(492 个) | 24 个非绿文件 —— 逐条在 oracle 上复现,**全部为预存** |
| 合并引入的新失败 | **1 个**:e2e `side-chat.test.ts`(回归 #9,已修) |

**归因方法(两侧 oracle 实测)**:
- **上游新增/改动文件** → 在纯上游 worktree(`c37ab2da`)上跑:`FileWriteTool.test.ts` 4/6、`opus55.test.ts` 2/1、`autoQuestionDecisionService.test.ts` 9/1、`constants/system.test.ts` 1/1,与合并态**逐字一致** → 预存。
- **fork 侧改动文件** → 在 fork main(`601230e0`)上跑:`conversation-service` 80/1、`conversations` 139/2、`sessions` 323/4、`title-service` 16/1、`e2e/full-flow` 32/1,失败用例名与合并态**完全相同** → 预存。
- **其余 24 个非绿文件**(`mac-installed-apps`、`macAppIcon`、`reviewService`、`claudemd`、`fileHistory.security`、`computerUse/*`、`workflows/save`、`userProvidedImages`、`skillAdapter`、`ImageGenTool/backend`、`workspaceWatch`、`open-target-service`、`skills`、`workflows-api`、`localFile`、`session-protocol-rollback` 等)→ 在 oracle 上**同样红或更红** → 预存(多为 Windows:macOS 专属、symlink EPERM、子进程探针无 stdout、EBUSY)。
- **3 个超时文件**(`traceCapture.bounds`、`imageDownload`、`teleport/api`)→ 在两侧 oracle 上**同样超时**,且**均未被本次合并改动** → 预存(Windows 子进程等待)。
- 唯一例外:`e2e/side-chat.test.ts` 在纯上游 `c37ab2da` 上 **通过**、在合并态 **3/3 失败**(且不是 EBUSY 而是 404)→ **合并回归 #9**,已修。

> 附:`check:server` 之所以「一条 lane 全废」,是因为 orchestrator 的 `finally rmSync` 在 `claudeBetas` 撞 EBUSY 后直接 `process.exit`,**丢弃了其余 586 个文件的结果**。这是本机跑 `check:server` 的正确姿势:要么修那个 `rmSync`(不提交),要么像本轮一样逐文件跑。CI(Linux) 无此问题。

## 独立审核

见本文件末尾「独立审核结论」一节(由独立子代理产出,与实现者分离)。

## 残余风险

- **冲突文件没有「合并结果」层面的等价 oracle,但有行级 oracle,且它确实管用。** 本轮补上了:`git merge-tree --write-tree` 复算两侧自动合并结果,再对每个冲突文件做「相对 merge base 的新增行在合并结果里是否还在」的行级比对。它**独立发现了第四批全部 3 类问题(#10–#12)**,其中 #10(README 图片)是**会让 CI 变红**的真回归。局限:该比对会报出「一侧删除、另一侧改写」造成的**假阳性**(两侧改同一行时,被合并选中的那一行会被记为另一侧的「丢失」)—— 本轮 49 个文件里绝大多数命中都是这类,需人工逐条判读。**建议把它固化为合并后的标准动作**,并配一份已知假阳性白名单。
- **fork 行为丢失的模式会重复出现。** 本次 12 处丢失全是「某一侧在函数内多加了一个字段/比较/兜底/守卫分支,合并取了另一侧」。`sessionService.ts` 一个文件就占了 6 处(#5–#9),其中 #9 是上游在同文件内**批量新增 12 条同形 `isSideChatId` 分支、合并只留 10 条** —— 这类「一侧批量加分支、另一侧整体覆盖」的冲突最易漏。**新增模式(#12):整个测试文件倒向一侧,上游新增用例静默消失** —— 这类丢失**不会让任何门禁变红**,只是悄悄降低覆盖,必须靠上面的行级比对或「上游新增/改动测试文件逐个跑」才能发现。
- **modify/delete 冲突的资源删除要跟着 fork 的引用走。** #10 的根因:上游删资源、fork 保留引用它的 README,而资源删除**不产生冲突标记**,只在 `git status` 里表现为一批 `D`。合并后凡「保留 fork 侧」的文件,都要检查它引用的资源是否被上游删掉了。
- **「与基线一致」对上游新增测试天然为真。** #6–#9 全部藏在上游 v0.6.7 **新增**的测试文件里,而基线清单只登记既有失败,于是比对基线永远显示「无新增」。**下次合并的硬性动作:先 `git diff --name-status <base>..<upstream> -- '**/*.test.ts'` 列出上游新增/改动的测试文件,逐个单独跑,再谈基线对照。** 这一步本可提前把 #6–#9 全部暴露。
- **root `src/` 仍无类型检查 lane。** `check:desktop` 只对 desktop 跑 `tsc`;root `src/` 的改动仅被测试验证。Bun 只剥离类型不检查。
- **合并对象是 tag 而非 `upstream/main` HEAD。** HEAD 上另有 3 个提交未纳入。若其中含关键修复,需单独 cherry-pick。
- **本地与 CI 失败集合不同。** 本地 desktop 2 / policy 7 / adapters 1 的失败在 CI 上不出现(或表现不同)。**以 CI 为准**,本地结果只用于快速定位。
- **`check:server` 本机退出码不可用,但覆盖已补齐。** 退出码因脚手架 `EBUSY` 恒为 1(基线同);本轮改以「逐文件跑 + 两侧 oracle 归因」补齐了 587 个文件的覆盖,确认合并引入的新失败**只有 1 个**(#9,已修),其余 56 个非绿文件全部为预存(Windows 环境 / 上游自身红)。CI(Linux) 结果仍应作为最终权威。
- **「跑测试」有结构性盲区,不能作为唯一手段。** #6–#9 靠跑测试发现,#10–#12 靠**行级机械比对**发现,两套手段互不覆盖:#10 会让 CI 变红但本机从未跑 docs lane;#11/#12 既不红也不绿(上限只影响极端配置;丢用例只是覆盖变薄)。**结论:合并收尾必须同时做「跑测试」与「对 49 个冲突做行级比对」,缺一不可。**

## 恢复工作方式

```bash
git fetch origin
git checkout merge/upstream-v0.6.7
bun install && cd desktop && bun install && cd ../adapters && bun install
cd .. && bun run check:policy && bun run check:provider-contract \
  && bun run check:chat-contract && bun run check:agent-flow && bun run check:server
cd desktop && node ./node_modules/typescript/bin/tsc --noEmit \
  && node ./node_modules/vitest/vitest.mjs run
# 全绿后:走 PR 合入 main
```

## 独立审核结论

_由独立子代理产出(与实现者分离)。方法:`git show` / `git diff` 对照两个父提交,`git merge-tree --write-tree` 作自动合并 oracle,逐文件归一化行比对,并针对性跑测试。工作区保持干净(临时文件已清理)。_

### 确认的缺陷(均已修复)

1. **`sessionService.ts` — effort 清理逻辑静默丢失(v0.6.6 失效模式复现)。** 合并后 `getMetadataProjection` 的折叠取的是 fork 侧那一行,从未手工回植上游的 `resolveSessionEffortLevel` 调用(该函数在别处 `sessionService.ts:4153,6199,6226` 有 import 与使用)。复现:`bun test src/server/services/sessionService.runtimeSelection.test.ts` → 4 pass / 3 fail。**对应本报告「真实功能回归」第 7 条。**
2. **新增的上游测试失败且未登记 —— CI `check:server` 会红。** `src/server/services/sessionService.metadata.test.ts`(上游独有,合并逐字节拷贝)为 0 pass / 4 fail;根因与第 1 条同类:合并后的 `getMetadataProjection` 走 `streamBoundedHistory`(跳过超限记录),而上游走 `sessionMetadataReader.streamSessionMetadata`(投影超限记录)。两个测试文件均不在 quarantine 或已知失败清单中,`run-server-tests.ts` 会发现所有 `src/**/*.test.ts`,故这 7 个失败本应在 CI 出现。**对应「真实功能回归」第 6 条。**

### 存疑项(审核代理明确标注为非合并引入)

- **`TaskUpdateTool.ts:363` 的 verification nudge 与 `noKeyValueNudges.test.ts:56` 冲突。** 经溯源:`git show 601230e0:...TaskUpdateTool.ts | grep -c verificationNudgeNeeded` = 4,且该文件是已登记的 quarantine 条目 —— **fork 侧预存,非本次合并引入**。

### 审核确认无回归的面(抽样)

- 冲突标记:`src/ desktop/src/ adapters/ scripts/` 中为零。
- `dead-imports.test.ts` 28 pass / 0 fail(修复 `74748173` 确认)。
- `README.md` / `README.zh-CN.md`:与 fork `601230e0` diff 为空;链接指向 `706412584/cc-haha`。
- provider 墓碑(teamorouter/xuanshuapi/fennoai/qiniuai 均 `deprecated:true`;jiekouai 可选无广告)、`xhigh` 可达、`withRetry.ts` relay 重试、`thinking` 无条件透传、`Code Council` wordmark —— 逐项在位。
- `prePlanPermissionMode`、`thinkingEnabled`、title-turn 计数器在位;`SCHEMA_V6` / `USAGE_ONLY_CONTROL_TIMEOUT_MS` 各仅一处声明(`traceMigrations.ts` 的同名常量属不同模块,非重复)。
- i18n 5 个 locale 对称,各 4349 key;`sessionProjector.ts` 的 INSERT 正确同时保留 fork 的 `thinking_enabled` 与上游的 `is_team_worker`(18 列 / 18 占位符)。
- `localIndex/database.test.ts` + `provider-presets.test.ts` 44 pass;`conversationService.teamWorkers.test.ts` 9 pass;`compact.test.ts` 14 pass。

### 审核的覆盖盲区(供后续补验)

- **未逐一检查全部 49 个冲突。** 深查:`sessionService.ts`、`handler.ts`、`conversationService.ts`、`chatStore.ts`、`sessionRuntimeStore.ts`、`runtimeSelection.ts`、`providerRuntimeEnv.ts`、`transcriptReducer.ts`、`sessionProjector.ts`、`ModelSelector.tsx`。**未查**:`ChatInput.tsx`、`AssistantMessage.tsx`、`ThinkingBlock.tsx`、`MessageList.tsx`、`ActiveSession.tsx`、`TabBar.tsx`、`WorkspaceFileTreePane.tsx`、`GeneralSettings.tsx`、`settingsStore.ts`、`types/settings.ts`、`api/settings.ts`、`providers.ts`,以及所有 `*.test.tsx` 冲突。
- **未跑完整 `check:server` / `check:desktop`**(Windows EBUSY / 时间)。上述两处缺陷是靠直接跑测试发现的,可能仍有其他新增测试在红。→ 由本报告的「真实功能回归」第 8 条(实现者随后发现)部分补上,但**不保证穷尽**。
