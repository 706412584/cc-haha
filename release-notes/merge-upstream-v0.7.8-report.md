# Merge Report — upstream v0.7.6 → v0.7.8 into fork main

> 合并提交：`merge/upstream-v0.7.8` 分支，含上游 v0.7.7 + v0.7.8（146 个上游提交）
> 合并基线：`283681751 release: v0.7.6 (#1745)` — 与 fork v0.8.9 上次合并点一致
> 上游 tag：`upstream-v0.7.8 = 98c9c08ce release: v0.7.8 (#1875)`

## 范围

| 项 | 数据 |
|---|---|
| 上游提交 | 146（含 v0.7.7 fbebbdee5、v0.7.8 98c9c08ce） |
| 文件变更 | 4218 文件，+540,137 / −8,813 行 |
| 自动合并成功 | 4147 |
| **冲突文件** | **71** |
| 冲突行 | ≈ +8,613 / −1,726 |

## 主要上游变更（按 PR）

### v0.7.7 (#1833)
- #1802 Magpie gateway + provider search tabs
- #1803 QA lifecycle 稳定化
- #1801 image error/cross-model thinking/rewind history 修复
- #1789/#1790 computer-use agent-desktop / ChatGPT 模型列表
- #1785 显式 HTTP server 地址
- #1786 默认主题对比度
- #1781 plain download names / Windows 默认未签名
- #1780 后台通知（无 push server）
- #1779 composer prompt suggestion
- #1778 Agent Teams 通信面板长历史性能
- #1776 MCP server 多项目共享
- #1775/#1773 thinking 调整
- #1774/#1770/#1768/#1766/#1763/#1762/#1761/#1760/#1759/#1758/#1757/#1755/#1753/#1749/#1748/#1747 一长串 UX/移动/工具改进

### v0.7.8 (#1875)
- **#1862** cloudflared 隧道保持唤醒 + 重启沿用隧道地址 + Wi-Fi 自动切换 + iPhone 推送
- **#1844/#1859** 手机 P2P 直连（打包版可用）+ 后台原地续会话只补增量
- **#1851** 回合运行中切换 ask/skip 权限
- **#1874** Claude Fable 5.2（1M context / 128K output，`fable` 别名指向 5.2）
- **#1869** ChatGPT Official 按模型设上下文窗口
- **#1819** 微信媒体投递（30MiB 文件 / 10MiB 图片 / 每轮 5 项）+ 通道状态面板 + `/delivery`、`/retry` 补发
- **#1858** 长思考流式不整块重解析（含表头表格、嵌套引用、四反引号）
- **#1843** 跨会话消息串台修复（重复消息 id）
- **#1811** 16MB 超大消息保留草稿 + 明确错误
- **#1835** 编辑非默认供应商不影响活跃会话
- **#1870/#1868/#1836** 无效 API key 立即失败、quota 耗尽显示「额度不足」
- **#1852** 带版本号（/v3、/v4）的 OpenAI 兼容 base URL 不再被追加 /v1
- **#1853** 单张坏图不再卡死会话
- **#1834/#1867** Memory reload 重读正文 + 输入框附件托盘限高内部滚动
- **#1854** worktree 会话中途进入后恢复不再报「找不到会话」
- **#1850/#1867** 输入框附件托盘限高内部滚动
- **#1848** 归档会话菜单精确出现在指针处
- **#1849** 团队成员页面直接回答问题
- **#1821** Glob 绝对路径权限判定 + OAuth token 并发刷新不互相覆盖 + Notebook 编辑拒绝部分读取
- **#1792** 插件 marketplace 列表正确显示
- **#1815** IM 连接层修复审批重复推送、断线丢消息、半开连接重连续原会话
- **#1857/#1855** 手机端移除连不上的电脑、Android 前台通知、发送后文本不回灌

## fork 保护清单（逐项验证）

### A. 品牌与链接
- ✅ README.md / README.zh-CN.md 取 fork 版（`git checkout --ours`）
- ✅ Code Council wordmark 仍在 Sidebar.tsx:1224（`Code <span>Council</span>`）
- ✅ 全库 NanmiCoder/cc-haha 链接已替换为 706412584/cc-haha（4 个上游新加 doc：code-signing/privacy 中英文）
- ✅ desktop/package.json homepage/description/productName 保 fork（version 升到 0.9.0）

### B. Provider 体系
- ✅ preset 墓碑：`shengsuanyun, teamorouter, xuanshuapi, fennoai, qiniuai` 全部保留（providerPresets.json）
- ✅ `get_channel_failed` 中继重试保留（withRetry.ts isRetryableStreamError + errors.ts 中文文案）
- ✅ `reasoning_content` 双向透传保留（openaiChatToAnthropic.ts、anthropicToOpenaiChat.ts）
- ✅ `xhigh` 推理档保留（effort.tsx、providerRuntimeEnv.ts、ModelSelector.tsx）
- ✅ providerCompat/thinking 徽章回植到上游新版 ProviderSettings.tsx（上游 #1802 search tabs 把 SortableProviderCard 重构了，fork 徽章被手动搬到新 badges 数组）
- ✅ buildOpenAIOfficialRuntimeEnv / buildGrokOfficialRuntimeEnv 双签名（含 modelContextWindows，#1869）

### C. 会话存储
- ✅ boundedSessionHistory 12MiB 上限 + slimOversizedEntry（HISTORY_RETAINED_RECORD_BYTES 命中 6 处）
- ✅ sessionService.invalidateReadCache 保留
- ✅ LOCAL_INDEX_SCHEMA_VERSION 迁移守卫
- ✅ 会话右键 Export/Copy path/Show in folder + 批量导出（Sidebar.tsx）
- ✅ localIndex/coordinator.ts fork 的 persistedDegraded / limitedPaths 保留

### D. 韧性
- ✅ CLAUDE_STREAM_TRANSIENT_RETRY_BUDGET_MS 保留
- ✅ StreamingIndicator data-retry-kind 保留
- ✅ PENDING_PERMISSION_DISCONNECT_CLEANUP_MS 保留

### E. 桌面 UX
- ✅ handleCompact（ContextUsageIndicator）
- ✅ toggleCoordinator / setPipeline（capabilityMenuModel）
- ✅ useEdgeAutoExpanded（ToolCallGroup）
- ✅ fetchServerImageBlobUrl / `-annotated.png`（ChatInput / ImageAnnotationModal）
- ✅ OFFICE_TAB_PREFIX（tabStore）
- ✅ material-symbols-outlined.woff2 自托管
- ✅ WorkspaceFileTreeMenu.tsx / WorkspaceEditableFile.tsx 文件存在
- ✅ getStaticSystemPromptSnapshot 在 constants/prompts.ts，conversationService.resolveSystemPromptFile 调用链闭合
- ✅ tunnel IPC channels + captureLogs 扩展 + tunnel state 字段（electron/capabilities/main/serverRuntime）

### F. 服务端
- ✅ replayPendingPermissionRequests 命中 5 处（ws/handler.ts）
- ✅ McpToolsTab / marketplace 浏览
- ✅ CATALOG_DESC_KEY（PluginList）
- ✅ applyKnownStoppedTasks 4 处（chatStore）
- ✅ fork stop/disconnect 边界（conversationService）+ takeActiveBackgroundTaskIds / broadcastStoppedBackgroundTasks / stopSettlements（ws/handler.ts）
- ✅ sessionActivityCoordinator.tryBeginUserTurn + mid-turn inject（ws/handler.ts user_message case）

### G. 保删除项
- ✅ searchContentCommitWorker.ts 仍不存在（fork 投影器架构）
- ✅ providerPresets.json 无 `featured` / `?ref=` 广告锚点

## 关键决策

1. **README.md** — `git checkout --ours` 保 fork，含 Code Council 品牌、定制节、fork 链接、自有赞助商。上游 v0.7.7 加的 kk-vibe 赞助位**剔除**（§B 去广告策略）。

2. **withRetry.ts** — 合并 fork 的 `hasAPIErrorType('api_error','overloaded_error','upstream_error','stream_read_error','get_channel_failed')` + Grok 流断开匹配，**加**上游的 `isContextOverflowErrorText` 早退（context overflow 不应重试，应触发 compact）+ `isLocalProtocolProxy` 早退本地服务。

3. **thinking.ts** — fork 在 `provider === 'firstParty' → return true` 完全覆盖了上游 `isMiniMaxAnthropicEndpoint` 的特定检查，**取 fork**（更通用），删除上游重复函数。

4. **sessionService.ts** — fork 已有 `getMetadataProjection`（旧版含 `complete` 字段），上游版本含 `transcriptMetadata`。**统一用上游**，删除 fork 旧版（6792-6942 行）。同时把 fork 的 cache 字段类型改为 `SessionMetadataProjection & { signature }`。fork 的 `InspectionFoldState` 加上 `additionalDirectories`（上游 #1791 per-project 目录），`hydrateIndexedSessionForList` fork 优化保留。

5. **ProviderSettings.tsx** — 上游 #1802 把 SortableProviderCard 重构了（新增 `matchNote / statusLine / dragDisabled / HighlightedText / MagpieModelChips` props）。fork 的 compat/thinking 徽章**手动搬到新版 badges 数组**——这是 fork §B 硬 pin 最容易丢失的点。

6. **ws/handler.ts** — fork 的 `sessionActivityCoordinator.tryBeginUserTurn` + mid-turn inject + clear 处理是 fork §F stop/disconnect 边界的关键，**保留**；上游的 `enqueueUserAdmission` 函数也保留（用于 adapters IM 路径）。两者目标不同：fork 是 user_message case 入口守卫，上游是 IM adapter 入口守卫。`__clearWebSocketDisconnectTimersForTests` 加上 `userAdmissionQueues` 清理。

7. **desktop/package.json** — version 升到 0.9.0（fork 自己版本号），description/homepage/productName 保 fork；build:electron 加上游 `p2p/hostPage.ts` 编译；NSIS 加上游 `artifactName` 但 fork NSIS 配置项保留。

8. **5 locale** — 同步上游 #1869（officialContext*）、#1779（promptSuggestions*）、#1862（preventSleep*）、`model.effortUnset`，fork 已有的 `sessionContentSearch*`、`model.thinking*` 全部保留。

9. **websocket-handler.test.ts** — fork 的 `rejects a second user message without releasing the active turn` 测试期望 fork 的 SESSION_TURN_ACTIVE 错误（与 fork user_message case 匹配），**取 fork 测试**而非上游 admission queue 版本。

10. **docs/en|zh/start/code-signing.md + privacy.md** — 上游 v0.7.7 SignPath 签名新文档，把 NanmiCoder/cc-haha 链接替换为 706412584/cc-haha（§A 硬 pin）。

## 测试

- 类型检查：`bun x tsc --noEmit -p tsconfig.json` 已改文件无错误
- 本地测试：`bun run check:server` / `check:desktop` 待跑（见后续 commit）
- 端到端验证：本地打包 Windows 安装包后逐项 dogfood

## 风险与后续

- 上游 #1843 跨会话串台修复与 fork 的 `desktop/src/lib/sessionTrace.ts` 诊断探针并存。上游已修，fork 探针可考虑下次清理。
- 上游 #1858 用 StreamingThinkingMarkdown 取代 fork 的 thinking-stream 纯文本渲染——fork 原方案被淘汰（保留 markdown 语义）。
- 上游 #1815 IM 可靠性改写与 fork 的 wechat createWechatGetUpdatesErrorHandler 共存——fork helper 仍用于测试与非 admission 路径。
- 合并后版本号：fork `0.9.0`（desktop/package.json）；release-notes/v0.7.7.md / v0.7.8.md 取上游原文。
