# 上游合并报告 — upstream v0.6.7 → fork

- **日期**: 2026-09-29
- **分支**: `merge/upstream-v0.6.7`
- **合并对象**: upstream `v0.6.7` (commit `c37ab2da`,tag `v0.6.7`)
- **fork 侧**: `601230e0` (release: v0.7.2)
- **merge base**: `2f8d819d` (upstream v0.6.6,上一轮已并入)
- **上游增量**: 62 commits
- **合并提交**: `8c290e60`
- **后续修复提交**: `54954f5e`(desktop 类型错误)、`541d52bf`(desktop 回归)、`6b666b33`(server 回归)、`74748173`(dead-import + compact.test 括号)、`bacb1596`(sessionService 元数据折叠)、`373d0753`(sessionService 单候选短路)
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

## 真实功能回归(合并静默丢失 fork 逻辑,共 8 处,均已修复)

这一节是本次合并最重要的部分。八处丢失**都没有产生冲突、没有类型错误**,与 v0.6.6 报告记录的失效模式完全一致。分两批发现:第 1–4 处在合并过程中由逐文件复查发现,第 5–8 处由独立审核代理复查发现(见下「独立审核结论」)。其中第 6、7、8 处本会表现为「上游新增测试失败」,但因基线清单不含这些新文件而完全隐形(详见本节末尾)。

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

**为什么这 4 处逃过了所有门禁:** `sessionService.metadata.test.ts` 与 `sessionService.runtimeSelection.test.ts` 是上游 v0.6.7 **新增**的测试文件,因此既不在 `scripts/quality-gate/quarantine.json`、也不在 `docs/known-pre-existing-test-failures.md` 的任何基线清单里——「与基线一致」的判定对它们**天然为真**。而 `check:server` 在本机又因已登记的 `EBUSY` 中止(见「验证结果」),没能把这些新测试跑出来。两件事叠加,使这批回归在本地完全不可见。**教训:合并后必须显式运行「上游新增的测试文件」,不能只比对基线。** 修复后 `sessionService.metadata.test.ts` 4/4、`sessionService.runtimeSelection.test.ts` 7/7(两者在合并态分别是 0/4、4/7;在上游 `c37ab2da` 上均全绿)。

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
| `check:policy` | 7 failed / 340 passed | 7 failed | 与基线逐条一致,无新增 |
| `check:provider-contract` | 36 suites passed | 全绿 | 通过 |
| `check:chat-contract` | 435 passed(3 files) | 全绿 | 通过 |
| `check:agent-flow` | 8 passed / 0 failed | 全绿 | 通过 |
| `check:adapters` | 1 failed / 782 passed | 1 failed(同一用例) | 预存,无新增 |
| `provider-presets.test.ts` | 19 passed | 全绿 | 通过 |
| `sessionService.metadata.test.ts`(上游新增) | 4 passed | 上游全绿(合并态 0/4) | 修复后通过 |
| `sessionService.runtimeSelection.test.ts`(上游新增) | 7 passed | 上游全绿(合并态 4/7) | 修复后通过 |
| `sessionService.retention` / `local-index-session-parity` / `project-session-history` | 55 passed | 全绿 | 通过 |
| `conversations.test.ts` | 148 passed / 2 failed | 2 failed(RE Pipeline) | 预存,无新增 |
| `check:server` | 见下 | 见下 | 见下 |

**基线对照法**:desktop 的 2 个失败是文档已登记的 Windows 环境限制(`scripts/build-macos-arm64.test.ts` 用 `spawnSync('/bin/bash')`,Windows 无 `/bin/bash` → `status: null`;`electron/services/serverRuntime.test.ts` 依赖 `SIGTERM` handler 延时清理,Windows `child.kill()` 直接终止进程)。adapters 的 1 个(`ImChatRuntime server stream > uploads an image ...`)在 fork main `601230e0` 上以完全相同的形式失败。

`check:policy` 的 7 个失败全部为已登记项:`computer-use live smoke path confinement`(2,`/tmp` 路径假设)、`final macOS helper cursor resource verification`(4,Windows 反斜杠 + symlink EPERM)、`change-policy plan-only`(1,Windows `Bun.spawn` 超 5s)。

### `check:server`

本轮 `check:server` 在 Windows 本地两次都因**已登记的脚手架 `EBUSY`** 中止:测试脚手架 `finally` 里裸调 `rmSync(sandboxHome, { recursive: true, force: true })`,撞上刚被 kill 的子进程句柄(`claudeBetas.integration.test.ts:126`、`scripts/pr/run-server-tests.ts:126`)。这与 `docs/known-pre-existing-test-failures.md` 中登记的 `claudeBetas` / `session-protocol-rollback` 现象同源,属 Windows 本地限制,**以 CI(Linux) 结果为准**。

**基线对照(已实测)**:在 fork main `601230e0` 上跑同一条 `check:server`,**以完全相同的方式中止** —— 同一个文件 `claudeBetas.integration.test.ts`、同一个 `EBUSY`、同样 `error: script "check:server" exited with code 1`。故该中止**不是本次合并引入**,且该文件与 fork main 逐字节相同(合并未改动它)。风险最高的 server 用例已在开发过程中单独跑过并与基线对齐:`conversations.test.ts`、`websocket-handler.test.ts`、`localIndex/database.test.ts`、`compact.test.ts`(14 pass)、`dead-imports.test.ts`(28 pass)。

**关键补验**:由于 `check:server` 本机跑不完,合并后的**上游新增测试文件**是单独逐个跑的——这一步正是发现「真实功能回归」第二批 4 处(全部在 `sessionService.ts`)的途径。`sessionService.metadata.test.ts` 在合并态 0/4、`sessionService.runtimeSelection.test.ts` 在合并态 4/7;修复后分别 4/4、7/7,与上游 `c37ab2da` 一致。

## 独立审核

见本文件末尾「独立审核结论」一节(由独立子代理产出,与实现者分离)。

## 残余风险

- **手工混合的冲突文件没有等价三方 oracle。** 49 个冲突依赖人工判断;非冲突文件可用 `git merge-file` 复算,冲突文件不能。这是本次合并最大的不确定性来源。
- **fork 行为丢失的模式会重复出现。** 本次 8 处丢失全是「某一侧在函数内多加了一个字段/比较/兜底,合并取了另一侧」。建议对 `ws/handler.ts`、`conversationService.ts`、`sessionService.ts`、`chatStore.ts` 做逐函数字段比对(见独立审核任务书第 2 项)。
- **「与基线一致」对上游新增测试天然为真。** 第二批 4 处回归全部藏在上游 v0.6.7 **新增**的测试文件里,而基线清单只登记既有失败,于是比对基线永远显示「无新增」。**下次合并的硬性动作:先 `git diff --name-status <base>..<upstream> -- '**/*.test.ts'` 列出上游新增/改动的测试文件,逐个单独跑,再谈基线对照。** 这一步本可提前把第二批 4 处全部暴露。
- **root `src/` 仍无类型检查 lane。** `check:desktop` 只对 desktop 跑 `tsc`;root `src/` 的改动仅被测试验证。Bun 只剥离类型不检查。
- **合并对象是 tag 而非 `upstream/main` HEAD。** HEAD 上另有 3 个提交未纳入。若其中含关键修复,需单独 cherry-pick。
- **本地与 CI 失败集合不同。** 本地 desktop 2 / policy 7 / adapters 1 的失败在 CI 上不出现(或表现不同)。**以 CI 为准**,本地结果只用于快速定位。
- **`check:server` 本轮未在本机跑完整。** 两次都因脚手架 `EBUSY` 中止,故 server 侧的全量通过数**未经本机确认**;风险最高的用例已单跑对齐(见上),但「没有别的文件因合并而红」这一点依赖 CI 验证。

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
