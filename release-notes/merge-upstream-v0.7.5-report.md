# 上游合并报告 — upstream v0.7.5 → fork

> 本报告由合并团队（merge-lead + 三轮独立审查）产出，主会话终审通过。

- **日期**: 2026-10-28
- **分支**: `merge/upstream-v0.7.5`
- **合并对象**: upstream `v0.7.5`（commit `d17c7b17b`，tag `v0.7.5`，v0.7.1..v0.7.5 共 241 个提交，其中未合并 68 个）
- **fork 侧**: `68e57e2fa`（fix(desktop): stop a finished migration receipt from blocking startup）
- **merge base**: `b0ed7f553`（上游 v0.7.1，即上次合并点）
- **合并策略**: 以 fork 为主，吸收上游优化；大改子系统以上游为基底回植 fork 定制点（与前四次合并一致）
- **规模**: 640 files changed, +62240/−3686；60 个冲突文件（120 个冲突块）逐文件解决
- **审查**: 3 轮独立代理审查（定制锚点审计 28/28 PASS / 定向测试 328 用例 / 上游语义反向核对 8/8）

## 上游 v0.7.1..v0.7.5 关键变更与取向

| 上游变更 | 取向 | 落点 |
| --- | --- | --- |
| #1544 auto-compact 死循环修复（rapid-refill breaker） | 取上游 + 回植 fork | compact/autoCompact.ts：fork 方案1/2/3（ineffective 计数、turn throttle、contextExhausted）与上游 rapid-refill breaker 全共存，throttle 先于 rapid-refill 判定 |
| #1600 流内错误重试（api_error/overloaded_error 吃 API 预算） | 取上游 + 回植 fork | withRetry.ts：transient 走 API 预算（上游语义），watchdog 保留 fork 默认 4 次；getStreamTransientRetryBudgetMs 60s 预算、get_channel_failed/api_error 5xx 全保留 |
| eb3d75aa6 proxy reasoning 字段过滤（unsupported/rejected fields） | 取上游 + 回植 fork | proxy/handler.ts：fork invariant `roundTripReasoningContent: true` 无条件透传保留，叠加上游 passThinkingToggle/passReasoningEffort 字段过滤与拒绝字段重试 |
| #1550 会话标签上限/恢复控制 | 取上游 | lib/tabBehavior.ts、sessionTabLimit.ts、tabBehaviorStore、GeneralSettings 接线全量落地；fork 的 OFFICE_TAB_PREFIX 锚点补入新文件 tabClose.ts |
| #1620 迁移权限预检 | 取上游 | migrationPermissions.ts + dataMigration.ts 接入；fork recover() 终态短路共存 |
| #1593/#1585 Windows console 修复 | 取上游（fork 版更严） | windowsPaths.ts 保留 fork 安全加固版（statSync isFile 校验、realpath 规范化、可信 System32 where.exe），语义覆盖上游 existsSync 方案；windowsHideSpawnSites.test.ts 守卫并入 |
| #1575/#1576 License 变更（Community Source License 1.0） | 跟随上游 | LICENSE/LICENSING.md/NOTICE 随上游；README.md/README.zh-CN.md 的 Code Council 品牌未动（冲突取 fork）；README.en.md 的 License 徽章与章节随上游 |
| #1532/#1599 ApiSmart 退役 → Zuiquan | 取 fork | preset 保留可用（不加 deprecated、保留 apiKeyUrl），featured 剔除；README.en.md 赞助区内容性更新按判定保留（见裁定 3） |
| #1546/#1618/#1627 Modelflare preset + Token usage 组件化重构（#1612） | 取上游 + 回植 fork | preset 工作字段并入但剔除 featured/isNew 推广位；ActivitySettings 取上游组件化（TokenHeatmap/TokenHero/ShareImageDialog 等），fork 旧内联 heatmap 由上游组件取代 |
| #1630 OpenCode Go Gemini 路由 | 取上游 | modelApiFormats 三规则 + upstreamHeaders 并入 |
| i18n 新 key（settings.tabs.*、agentProfile.*、delegation.* 等） | 取上游 | 5 locale 同步（en/zh/jp/kr/zh-TW 各 5139 key，0 缺失 0 多余） |

## fork 定制点保护清单（对照 docs/FORK_CUSTOMIZATIONS.md）

第 1 轮逐项审计 **28/28 PASS，0 FAIL**。按节摘要：

- **A 品牌与链接**：README.md/README.zh-CN.md 零改动；wordmark 在 Sidebar.tsx:1146（AppShell 无 Council 属 fork HEAD 既有状态，非丢失）；NanmiCoder 链接与 fork HEAD 逐字节一致，未引入新痕迹
- **B Provider 体系**：5 墓碑（teamorouter/xuanshuapi/fennoai/qiniuai/shengsuanyun）deprecated 集合精确匹配；jiekouai 无 deprecated/featured/promoText；modelflare 的 featured/isNew 已剔除；?ref=/?aff=/Sponsor=0；featuredIds==[] 断言在；get_channel_failed(:299)、api_error 5xx(:1111)、默认 4 次(:444)、60s 预算(:458)；thinking 透传 handler.ts:824 无条件 roundTripReasoningContent:true；xhigh 档与官方账号 runtime env 在位
- **C 会话存储/索引**：LOCAL_INDEX_SCHEMA_VERSION=9（agent_profile 落 v9，hasColumn 幂等守卫）；12MiB 上限、invalidateReadCache 单写（无双写）、Export JSONL/批量导出均在
- **D 中转/断流韧性**：D 节锚点全在（含 handler.ts:202 五分钟断连清理）
- **E 桌面 UX**：wordmark、Office 入口（TabBar:755-766 + tabStore:24 + tabClose.ts:14,35 + AppShell modal）、TabBar 双箭头/滚轮横滚、material-symbols woff2、右键菜单文件、列宽变量（max-w-[900px]=0）全 PASS
- **F 服务端行为**：replayPendingPermissionRequests、McpToolsTab、Plugins/Skills 不 early-return、applyKnownStoppedTasks ×3（4629/4760/5013）全 PASS
- **G 保删除**：searchContentCommitWorker.ts 及 lifecycle.test.ts 全树不存在；34aa9d710 revert 是 HEAD 祖先；#1513/#1514 未复活

## 冲突解决明细（60 文件 → 三类取向）

### 保 fork（上游弃用，11 文件）
| 文件 | 说明 |
| --- | --- |
| README.md | 上游改动弃用（Code Council 品牌/定制节/fork 链接不动） |
| desktop/package.json | version 0.8.7、Code Council 描述、706412584 homepage |
| release-notes/v0.7.2.md ~ v0.7.5.md（×4，AA 冲突） | 取 fork 发布记录；上游同名文件内容体现在本报告 |
| src/utils/windowsPaths.ts | fork 安全加固版全保留（statSync isFile、realpath、可信 where.exe、findExecutables 多候选）；上游旧版 findExecutable 弃用 |
| src/server/services/providerRuntimeEnv.ts（部分） | 动态 isManagedProviderEnvKey 覆盖上游静态 PROVIDER_ENV_KEYS 全部键 → 取动态机制 |
| src/server/config/providerPresets.json | 5 墓碑保留；接口AI 可选无广告；上游对 apismart 的 deprecated 拒绝；modelflare 剔 featured/isNew |
| .github/workflows/nightly-quality.yml | ripgrep 注释取并集 |
| .github/workflows/release-desktop.yml | fork 的 unsigned-macOS 条件跳过 + 上游 --max-linux-glibc 参数并存 |
| desktop/src/hooks/useKeyboardShortcuts.ts | fork 的 setActiveSession/setActiveView/sidebar 快捷键保留 |
| desktop/src/components/ui/Dropdown.tsx（部分） | 取上游 portal 重构 + 回植 fork onWheel stopPropagation |

### 取上游 + 回植 fork 点（44 文件）
| 文件 | 融合要点 |
| --- | --- |
| src/services/api/withRetry.ts + streamRetry.test.ts + withRetry.test.ts | 上游 transient 吃 API 预算语义；fork watchdog 默认 4 次、60s 墙钟预算、get_channel_failed；测试断言适配为 transient=API 预算（1+3）、watchdog=1+4 |
| src/services/api/client.ts | authToken 分支取上游（含 usingDeepSeek）；fork OpenAI/Grok runtime env 分支在自动区保留 |
| src/server/proxy/handler.ts | fork 无条件 reasoning 透传 + 上游 thinking/reasoning_effort 字段过滤；移除无消费的 reasoningProfile 局部变量 |
| src/server/services/conversationService.ts | fork instanceId 停止边界 + 上游 runtimeSelection；SIGKILL 确认退出融合（上游 killed 语义 + fork sync 参数）；env strip 用 fork 动态清单；tool-input 预算随请求超时（上游）+ fork thinking cap 注入并存 |
| src/server/services/sessionService.ts（8 处） | fork readJsonl 缓存/append 增量架构 + 上游 omission/mayContainEntry 流式路径（omission 请求绕缓存防投毒）；getMetadataProjection 融合 fork prePlan/thinking/providerTransition/complete + 上游 agentProfile/isTeamWorker；clearSessionTranscript 取上游流式 preserved + fork prePlan tombstone；snapshots 取上游 bounded/budget 三分支 |
| src/server/services/localIndex/migrations.ts | **agent_profile 落 v9**（双方 v8 均被占用：fork=openai_fast_mode，上游=agent_profile）；LOCAL_INDEX_SCHEMA_VERSION=9；hasColumn 守卫 +v9 分支 |
| src/server/services/localIndex/sessionProjector.ts | sessions INSERT 20 列 = 双方字段并集（thinking_enabled/is_team_worker/openai_fast_mode + agent_profile） |
| src/query.ts | tracking 融合 fork consecutiveFailures + 上游 consecutiveRapidRefills |
| src/services/compact/autoCompact.ts + autoCompact.test.ts + compact.test.ts | fork 三方案 + 上游 rapid-refill breaker 全共存；测试 import 取并集（fork timeout 组 + 上游 fork-allowance/delta 组） |
| src/server/api/skills.ts | fork catalog/active/install 路由 + 上游 agentProfile 参数 |
| src/server/api/models.ts | 上游 buildActiveProviderModelList 封装（DeepSeek catalog）+ fork presetModels 第 5 参（glm-5.3 能力别名） |
| src/server/api/providers.ts | fork fetch-models 代理 + 上游 readAuthStatusProviderId 并存 |
| src/server/services/networkSettings.ts | fork thinking cap 常量 + 上游 tool-input 预算函数并存 |
| src/server/ws/handler.ts | fork coordinatorMode/pipelineMode/handoffSummarySessions + 上游 strictCollaborationRuntimeSessions 并存；grok 分支融合 fork resolvedModelId + 上游 strict 抛错；测试辅助函数并集 |
| src/commands/headless.ts + headless.test.ts | 上游 agentProfile 过滤 + fork 队列函数（removeStale/wakeContinuation）并存 |
| src/utils/queryHelpers.test.ts | fork thinking-only 测试 + 上游 normalizeMessage 测试并存 |
| src/services/api/claudeRequiredThinking.test.ts | fork thinking-cap 测试 2 个 + 上游 silent-gap 测试 2 个并存 |
| desktop/src/components/layout/TabBar.tsx | fork 滚轮横滚/双箭头/Building2 Office 入口保留；关闭策略迁上游 tabClose.ts（OFFICE_TAB_PREFIX 已补锚）；fork 空占位删除 |
| desktop/src/stores/tabStore.ts + tabStore.test.ts + tabClose.ts | fork openTraceTab 保留；上游 #1550 全套并入；tabClose.ts 补 OFFICE_TAB_PREFIX |
| desktop/src/components/chat/ChatInput.tsx + useCapabilityMenu.ts + EmptySession.tsx | fork orchestration 开关 + 上游 lean 模式并存（两 composer 一致） |
| desktop/src/components/chat/capabilityMenuModel.ts | fork 编排菜单锚点（F 节）保留，上游 lean 过滤接入 |
| desktop/src/components/activity/*（Panel/model/useSessionActivityModel） | fork queue 行/recentEvents/hideRunningLabel/10s 轮询 + 上游 delegatedSession 行/sessions 区/accessories 并存；model 的 input 并集（queuedMessages + delegatedSessions） |
| desktop/src/pages/ActiveSession.tsx | fork 布局/handler 命名 + 上游 delegation dock/review bar 并存 |
| desktop/src/pages/ActivitySettings.tsx | 取上游 #1612 组件化重构（fork 旧 heatmap 被上游 TokenHeatmap 取代，功能等价升级） |
| desktop/src/pages/settings/ProviderSettings.tsx | fork 无赞助星标策略保留（注释明示）；import 取上游 ModelApiFormat 并集 |
| desktop/src/pages/McpSettings.tsx | fork syncWarningDetail 机制保留 + 上游 lean_profile 分支补入 |
| desktop/src/lib/runtimeSelection.ts | fork effort 推导链保留（消费者 ModelSelector 仍传 effortLevel）+ 上游 DeepSeek 默认模型分支 |
| scripts/quality-gate/coverage.ts + coverage.test.ts | fork excludePrefixes（cli/entrypoints/hooks/screens/types、AgentTool、ws/events、localIndex/types）+ 上游 __fixtures__/unavailableScopes；changedLines 融合 fork baseRef 守卫 + 上游 unmeasured 语义 |
| scripts/quality-gate/package-smoke/index.ts + index.test.ts | fork PACKAGE_SMOKE_ALLOW_MISSING_CU_HELPER env + 上游 max-linux-glibc/linuxElf 校验并存；fork plugin-seed 断言保留 |

### 保删除（1 文件）
| 文件 | 处理 |
| --- | --- |
| src/server/services/localIndex/searchContentCommitWorker.ts | `git rm` 不复活；上游新增的 searchContentCommitWorker.lifecycle.test.ts 一并删除；fork 投影器架构（searchContentProjector/Coordinator/Index/Database）全数健在 |

## 跟进提交

### 测试适配修复（第 2 轮发现的 4 处，修复后逐文件重跑全绿）
1. `src/server/__tests__/provider-presets.test.ts`（2 fail → 22 pass）：Modelflare/ApiSmart 用例从上游语义重适配为 fork 语义（不进赞助行、不退役）
2. `desktop/src/config/providerPresets.test.ts`（整文件崩溃 → 15 pass）：补回被冲突拼接吃掉的 it 闭合 `})`
3. `desktop/src/api/providers.test.ts`（2 fail → 5 pass）：上游全量 vi.mock('./client') 改 importOriginal 部分 mock，恢复 fork fetchModels 用例的 setBaseUrl
4. `src/server/services/localIndex/database.test.ts`（1 fail → 28 pass）：frozen v6 用例补 `agent_profile: 'standard'`（v5 用例已适配、v6 漏改）

### 品牌链接修复（第 1 轮审计建议，team-lead 批准）
5. `desktop/src/features/tokenUsage/useActivityProfile.ts:13`：分享图默认署名 `github.com/NanmiCoder/cc-haha` → `github.com/706412584/cc-haha`

### 连带发现修复（同源适配遗漏）
6. `desktop/src/features/tokenUsage/ShareImageDialog.tsx`：THEME_LABEL_KEYS 按上游 6 主题编写，fork THEME_MODES 已扩至 10 主题 → 补齐 classic-white/classic-light/eye-care/classic-dark 4 个 label key；ShareImageDialog.test.tsx 主题清单断言同步为 11 项。tokenUsage 全目录 88 pass / 0 fail

### 文档漂移回填提示（后续提交处理，不在本合并内）
- docs/FORK_CUSTOMIZATIONS.md C 节：「当前 v8」→「当前 v9」（agent_profile 落 v9）
- docs/FORK_CUSTOMIZATIONS.md A 节：wordmark 锚点移除 AppShell.tsx（fork HEAD 与合并后均无 Council 字样，实际锚点仅 Sidebar.tsx:1146）

## 三项裁定（第 1 轮审计裁定）

1. **README.en.md 的 NanmiCoder 头部链接 → 豁免**：与 fork HEAD 逐字节一致（Stars/Forks/Issues/PR 徽章行），属 fork 既有状态而非合并引入；上游自有 AtomGit 行亦然（v0.7.1 合并报告有先例）
2. **desktop locale.test.ts 裸 bun test 缺 DOM → 测试环境问题**：需按项目测试配置（happy-dom）运行，非合并缺陷
3. **README.en.md 的 Modelflare Platinum Sponsor 横幅 → 判定保留**：fork HEAD 本就保留上游 apismart 赞助区（en 版为上游英文版），本次只是内容性更新赞助商身份；B 节去广告锚点仅限 providerPresets.json 且验证全过；主 README.md/README.zh-CN.md 无赞助内容且零改动

## 审查结论

- 第 1 轮锚点审计：28/28 PASS，0 FAIL
- 第 2 轮定向测试：328 用例基线 + 修复后逐文件复跑全绿（server provider-presets 22 / desktop providerPresets 15 / desktop providers 5 / localIndex database 28 / tokenUsage 88）
- 第 3 轮上游语义：68 个未合并上游提交的 8 个关键语义点全部真实吸收（#1544/#1600/reasoning 过滤/#1550/#1620/#1593+#1585/License/i18n），fork 共存锚点全部保留
- 保删除项零复活；5 locale 5139 key 零漂移
