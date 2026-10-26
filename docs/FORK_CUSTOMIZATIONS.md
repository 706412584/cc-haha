# Fork 定制清单（Code Council Customizations Inventory）

> **用途**：上游合并时对照的唯一权威清单。每项含文件锚点与验证方法。
> **维护规则**：新增 fork 定制时同步登记；合并报告（`release-notes/merge-upstream-vX-report.md`）的「保护清单」节按本清单生成；发现合并丢失后必须把该项的锚点回填本清单。
> **最后核对**：2026-10-26（对照 fork v0.8.7 / 上游 v0.7.1 合并后 HEAD）

## 使用方法（每轮上游合并）

1. 合并前：`git diff <merge-base> main -- <锚点文件>` 生成 fork 侧基线快照。
2. 冲突解决时：逐项核对下表锚点，取向三类——**保 fork** / **取上游+回植 fork 点** / **保删除（不复活上游功能）**。
3. 合并后审查：按「验证」列逐项跑 grep/测试；任何一项丢失立即 `fix(merge)` 并回填本清单。
4. CLAUDE.md 的 7 条硬 pin 是本清单的子集（标记 ★）。

---

## A. 品牌与链接（硬 pin ★）

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| ★ README.md / README.zh-CN.md 永不被上游覆盖（Code Council 品牌、定制节、fork 链接） | `README.md`、`README.zh-CN.md`、`README.en.md` | `git diff <merge-base> main -- README.md README.zh-CN.md` 预期仅 fork 侧有改动；冲突一律取 fork |
| ★ Code Council wordmark | `desktop/src/components/layout/Sidebar.tsx:1123`（`Code <span>Council</span>`）、`desktop/src/components/layout/AppShell.tsx` | grep `Council` 两文件 |
| ★ 全库 GitHub 链接指向 `706412584/cc-haha` | 全库 | `grep -rn "NanmiCoder/cc-haha\|anthropics/claude-code" --include="*.md" --include="*.ts"`（排除 node_modules/release-notes 历史报告）应为 0 |

## B. Provider 体系

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| ★ preset 墓碑：teamorouter / xuanshuapi / fennoai / qiniuai / shengsuanyun `deprecated: true` | `src/server/config/providerPresets.json` | python json 解析列 deprecated id，应为上列 5 个 |
| 接口AI（jiekouai）可选、无广告 | `providerPresets.json:147` | 无 `deprecated`、无 `featured`、无推荐码 |
| 去广告策略：上游赞助位剔除（aruhub 无 sponsor 星标；opencode-go 无 `?ref=`） | `providerPresets.json` | grep `?ref=`、`Sponsor`、`aria-label="Sponsor"` 为 0；`featuredIds === []`（`desktop/src/config/providerPresets.test.ts`） |
| 中性 promoText 保留（zhipu 邀请链接、LM Studio/Ollama 配置说明） | `providerPresets.json:67,441,460` | 合并 diff 审查时不误删 |
| ★ relay 重试：`get_channel_failed` + `api_error` 5xx | `src/services/api/withRetry.ts:294-298,1087,1095` | grep `get_channel_failed` 非零；`withRetry.test.ts` 对应用例绿 |
| ★ `thinking` 透传（reasoning_content / reasoning 双向） | `src/server/proxy/transform/openaiChatToAnthropic.ts:35-37`、`anthropicToOpenaiChat.ts` | grep `reasoning_content`；上游合并不得条件化该透传 |
| ★ `xhigh` 推理档（K3/兼容模型），含 ultracode/max 档位 | `src/commands/effort/effort.tsx:30`、`src/server/services/providerRuntimeEnv.ts`（grep `xhigh_effort`） | ModelSelector / ReasoningEffortPopover 测试绿 |
| Provider 运行时环境官方账号分支（OpenAI/Grok OAuth runtime env） | `src/server/services/providerRuntimeEnv.ts` | grep `buildOpenAIOfficialRuntimeEnv`、`buildGrokOfficialRuntimeEnv` |
| Provider compat/thinking 徽章 + media proxy 步骤标签 | `desktop/src/pages/settings/ProviderSettings.tsx` | 合并 diff 目视 |

## C. 会话存储 / 索引 / 历史

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| localIndex schema：fork 列（`thinking_enabled` 等）与上游列分叉时落在双方都空出的版本号；`is_team_worker` = v7，当前 v8 | `src/server/services/localIndex/migrations.ts:3,179,207` | `LOCAL_INDEX_SCHEMA_VERSION` 与列守卫（`hasColumn` 幂等） |
| boundedSessionHistory 12MiB 上限 + slimOversizedEntry | `src/server/services/boundedSessionHistory.ts:23,188` | grep `HISTORY_RETAINED_RECORD_BYTES` |
| sessionService.appendJsonlEntry：保留 fork `invalidateReadCache`，不做双写 | `src/server/services/sessionService.ts` | grep `invalidateReadCache`；确认无重复 appendFile |
| 会话右键菜单 Export JSONL / Copy path / Show in folder + 批量导出 | `desktop/src/components/layout/Sidebar.tsx:892-932` | grep `exportSession` |

## D. 中转/断流韧性

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| 流断线重试预算 `CLAUDE_STREAM_TRANSIENT_RETRY_BUDGET_MS`（默认 60s）+ fork 默认 4 次重试 | `src/services/api/withRetry.ts:439-443`、`src/services/api/streamRetry.ts:83` | grep `getStreamTransientRetryBudgetMs`；`streamRetry.test.ts` 绿 |
| 流断线重试横幅（kind-specific 文案 + data-retry-kind） | `desktop/src/components/chat/StreamingIndicator.tsx` | grep `data-retry-kind` |
| `PENDING_PERMISSION_DISCONNECT_CLEANUP_MS` 保 5 分钟（上游为自动回答提到 31 分钟） | `src/server/ws/handler.ts:196` | grep 该常量 |

## E. 桌面 UX（fork-only / 改上游）

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| 手动 compact 动作（ContextUsage 弹出层 → `/compact` 走消息链） | `desktop/src/components/chat/ContextUsageIndicator.tsx:511-517` | grep `handleCompact` |
| Composer 能力菜单三个编排开关（coordinator / solo / re pipeline） | `desktop/src/components/chat/capabilityMenuModel.ts:60-63,451` | grep `toggleCoordinator`、`setPipeline` |
| ToolCallGroup：useEdgeAutoExpanded 边缘触发自动展开、isStreaming 状态、media-gen 内联画廊、20k 预览截断 | `desktop/src/components/chat/ToolCallGroup.tsx:81` | grep `useEdgeAutoExpanded` |
| 图片标注流：ImageAnnotationModal + authedImage 鉴权 fetch + annotate-and-ask 预填 + `-annotated.png` 兄弟路径过滤 | `desktop/src/components/chat/ImageAnnotationModal.tsx:4`、`desktop/src/components/chat/ChatInput.tsx:1217` | grep `fetchServerImageBlobUrl`、`-annotated.png` |
| Agent Office 入口：TabBar Building2 按钮 + AppShell modal + OFFICE_TAB_PREFIX 不算 session tab | `desktop/src/components/layout/TabBar.tsx`、`desktop/src/stores/tabStore.ts` | grep `OFFICE_TAB_PREFIX` |
| TabBar：双箭头槽位 unmount、滚轮横滚、team-member activity 守卫 | `desktop/src/components/layout/TabBar.tsx` | 合并 diff 目视 + TabBar 相关测试 |
| Material Symbols 字体类（自托管 woff2，防 21 个图标 span 渲染原始文本） | `desktop/src/theme/globals.css:4-12` | grep `material-symbols-outlined.woff2` |
| 文件树右键 WorkspaceFileTreeMenu + WorkspaceEditableFile（上游已删，fork 保留） | `desktop/src/components/workbench/WorkspaceFileTreeMenu.tsx`、`WorkspaceEditableFile.tsx` | 文件存在 + 对应测试绿 |
| 聊天内容列宽 `var(--chat-content-max-width)`（不得回退到上游 800px 硬编码） | `desktop/src/components/chat/BackgroundTasksBar.tsx`、`SessionTaskBar.tsx` | grep `max-w-\[900px\]` 应为 0 |

## F. 服务端行为

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| 权限请求重放 replayPendingPermissionRequests | `src/server/ws/handler.ts:917,5623` | grep 该函数 |
| MCP 会话热注入（handleToggle/Save/Reconnect/Refresh 传 activeSessionId）+ McpToolsTab + marketplace 浏览 | `desktop/src/pages/McpSettings.tsx:708` | grep `McpToolsTab` |
| Plugins 推荐目录 + URL 安装 + Configure 按钮（空列表不 early-return） | `desktop/src/components/plugins/PluginList.tsx:38-48` | grep `CATALOG_DESC_KEY`；`pluginsSettings.test.tsx` 绿 |
| Skills 推荐目录节 + 空已安装列表不 early-return | `desktop/src/components/skills/SkillList.tsx` | `skillsSettings.test.tsx` 绿 |
| chatStore 冷恢复对账 `applyKnownStoppedTasks(killStaleRunningTasks(..., confirmedActiveTaskIds), sessionId)`（loadHistory 与 reloadHistory 两分支都要） | `desktop/src/stores/chatStore.ts:4622,4753,5006,8028` | grep `applyKnownStoppedTasks` 应 ≥3 处 |
| fork 的 stop/disconnect 边界（与上游 #1501 进程回收共存） | `src/server/services/conversationService.ts` | 合并报告 v0.7.1 关键决策 3 |

## G. 保删除项（上游功能，fork 主动移除——合并时**不要复活**）

| 已删项 | 处理 |
| --- | --- |
| `searchContentCommitWorker.ts`（+test） | fork 已改投影器架构；上游对该文件的修改一律弃用 |
| 上游 #823 ToolSearch 强制启用 | revert 状态保持（commit `34aa9d710`） |
| 上游 #703/#707/#712/#751 pending tool UI | 同上 |
| 上游 #1513/#1514 会话标签条/侧聊 | 跟随上游 revert；fork 的 TabBar 双箭头行为保留 |
| AruHub sponsor 星标、上游新增 featured 推广位 | 按 B 节去广告策略剔除 |

## H. README「Customizations」节的功能级大项（面向用户的描述，锚点从略）

provider preset UI、IM 适配器（adapters/：telegram/feishu/slack/钉钉/企微/QQ/微信/WhatsApp）、定时任务（cron GUI）、Agent Teams + REST/WebSocket API、Shiki 高亮、react-diff-viewer-continued diff、折叠工具组、`@` 文件搜索、i18n（5 locale：en/zh/jp/kr/zh-TW 同步）、自托管字体、Esc 暂停尊重、后台代理完成 file_edits 忠实上报、冷重连停止稳定、协调者/Solo/RE 编排模式、团队共享记忆、团队中断恢复、H5 手机隧道（cloudflared 零安装 + Pinggy 回退）、本地语音听写、媒体生成 media-gen 插件、spark2-gamedev 插件。

> 功能级大项的详细实现锚点分散在各子系统；合并时以上面 A–G 的文件级锚点为准逐项核对。

---

## 附：历史丢失记录（fix(merge) 提交索引）

| 上游版本 | 恢复提交 | 丢失内容摘要 |
| --- | --- | --- |
| v0.6.1 | `06323c8d9`、`e1a2ac947` | JSONL 双写缺陷、冷恢复对账丢失、MCP 路由/projectHistory init |
| v0.6.6 | `e702f1e0e`、`f4cd90e4b` | pre-plan 权限模式持久化等 |
| v0.6.7 | `54954f5ea`、`541d52bf3`、`6b666b33a`、`74748173b`、`bacb15961`、`373d07534`、`2bc81c086`、`f32f4cf3d` | desktop/server 回归、元数据折叠、单候选短路、side-chat 守卫 |
| v0.6.8 | `4e43df3a2` | 上游行为回补 |
| v0.7.0 | `ecaa96936`、`c29485c35`、`468e72936`、`e5799b053`、`eebdd53d7` | 4 轮：图标类名、图片标注、wordmark、Office 入口、右键菜单、TabBar、Plugins/MCP 页、流重试预算、12MiB 上限、checkpoint 预算守卫 |
| v0.7.1 | `24e0773fb`、`ab8748ac4`、`079f29423`、`a93071240`、`c139268a6`、`1b2a52170` 等 | 停止路径半合并、openAIFastMode 折叠、limiter 门控 |
