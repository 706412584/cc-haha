# 上游合并报告 — upstream v0.6.7 → fork

- **日期**: 2026-09-29
- **分支**: `merge/upstream-v0.6.7`
- **合并对象**: upstream `v0.6.7` (commit `c37ab2da`,tag `v0.6.7`)
- **fork 侧**: `601230e0` (release: v0.7.2)
- **merge base**: `2f8d819d` (upstream v0.6.6,上一轮已并入)
- **上游增量**: 62 commits
- **合并提交**: `8c290e60`
- **后续修复提交**: `54954f5e`(desktop 类型错误)、`541d52bf`(desktop 回归)、`6b666b33`(server 回归)、`74748173`(dead-import + compact.test 括号)
- **合并策略**: 以 fork 为主,吸收上游优化;大改子系统以上游为基底回植 fork 定制点

> 为什么合并对象是 tag 而不是 `upstream/main` HEAD:HEAD 比 tag 多 3 个提交。本次按用户指定锁定 tag,保持发布点可复现。

## 合并概况

- 合并提交触及 **580** 个文件(+28534 / −7073)。相对 fork main 的净差为 581 文件(+28595 / −7081,含 4 个修复提交)。
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

## 真实功能回归(合并静默丢失 fork 逻辑,共 4 处,均已修复)

这一节是本次合并最重要的部分。四处丢失**都没有产生冲突、没有类型错误、没有测试失败**,与 v0.6.6 报告记录的失效模式完全一致。

1. **`ws/handler.ts` — `replayPendingPermissionRequests` 丢失。** 合并后的 `bindClientSessionOutput` 内联 `forward` 回调丢了上游 v0.6.7 新增的「leader 回合结束后重放等待中的权限请求」逻辑。后果:leader 回合完成时渲染端提示被清空,而独立 worker 仍在等回答 —— 该提示不再出现,用户看到的是卡住的队友。已回植:`if (serverMsgs.some(msg => msg.type === 'message_complete')) replayPendingPermissionRequests(ws, sessionId)`。由 `websocket-handler.test.ts > restores a waiting teammate permission` 捕获。
2. **`ws/handler.ts` — stale-modelId 守卫口径错误。** fork 的运行时模型 id 带 `[1m]` / `:1m` 后缀,而 provider 的槽位表从不存后缀。守卫直接用原始 id 比较,于是**每一次 1M 选择都被判为过期模型并回退到普通 main 模型**。修复:引入 `baseModelId()` 剥掉后缀再比较。由 `conversations.test.ts` 的 `it.each ... (high, replay=true)` 捕获。
3. **`ws/handler.ts` — `interruptBoundaryPending` 守卫丢失。** fork 用这个闩锁让第二次 Stop 成为 no-op;丢失后重复点击 Stop 会重复发中断。已恢复守卫,并给 leaderless-stop 的中断加上 `!sessionStopRequested.has(sessionId)` 约束(上游新增的「leader 空闲但仍有 worker」撤销路径保留,但不再与闩锁打架)。由 `counts repeated Stop clicks once` 捕获。
4. **`localIndex/migrations.ts` — 版本号冲突 + 重复声明。** 自动合并产生了**两个 `const SCHEMA_V6`**,并且直接采用上游版本号会让 fork 支线缓存误判。已按「关键架构决策 1」重构。

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
| `check:server` | 见下 | 见下 | 见下 |

**基线对照法**:desktop 的 2 个失败是文档已登记的 Windows 环境限制(`scripts/build-macos-arm64.test.ts` 用 `spawnSync('/bin/bash')`,Windows 无 `/bin/bash` → `status: null`;`electron/services/serverRuntime.test.ts` 依赖 `SIGTERM` handler 延时清理,Windows `child.kill()` 直接终止进程)。adapters 的 1 个(`ImChatRuntime server stream > uploads an image ...`)在 fork main `601230e0` 上以完全相同的形式失败。

`check:policy` 的 7 个失败全部为已登记项:`computer-use live smoke path confinement`(2,`/tmp` 路径假设)、`final macOS helper cursor resource verification`(4,Windows 反斜杠 + symlink EPERM)、`change-policy plan-only`(1,Windows `Bun.spawn` 超 5s)。

### `check:server`

本轮 `check:server` 在 Windows 本地两次都因**已登记的脚手架 `EBUSY`** 中止:测试脚手架 `finally` 里裸调 `rmSync(sandboxHome, { recursive: true, force: true })`,撞上刚被 kill 的子进程句柄(`claudeBetas.integration.test.ts:126`、`scripts/pr/run-server-tests.ts:126`)。这与 `docs/known-pre-existing-test-failures.md` 中登记的 `claudeBetas` / `session-protocol-rollback` 现象同源,属 Windows 本地限制,**以 CI(Linux) 结果为准**。

**基线对照(已实测)**:在 fork main `601230e0` 上跑同一条 `check:server`,**以完全相同的方式中止** —— 同一个文件 `claudeBetas.integration.test.ts`、同一个 `EBUSY`、同样 `error: script "check:server" exited with code 1`。故该中止**不是本次合并引入**,且该文件与 fork main 逐字节相同(合并未改动它)。风险最高的 server 用例已在开发过程中单独跑过并与基线对齐:`conversations.test.ts`、`websocket-handler.test.ts`、`localIndex/database.test.ts`、`compact.test.ts`(14 pass)、`dead-imports.test.ts`(28 pass)。

## 独立审核

见本文件末尾「独立审核结论」一节(由独立子代理产出,与实现者分离)。

## 残余风险

- **手工混合的冲突文件没有等价三方 oracle。** 49 个冲突依赖人工判断;非冲突文件可用 `git merge-file` 复算,冲突文件不能。这是本次合并最大的不确定性来源。
- **fork 行为丢失的模式会重复出现。** 本次 4 处丢失全是「某一侧在函数内多加了一个字段/比较/兜底,合并取了另一侧」。建议对 `ws/handler.ts`、`conversationService.ts`、`sessionService.ts`、`chatStore.ts` 做逐函数字段比对(见独立审核任务书第 2 项)。
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

_待独立审核代理返回后补入。_
