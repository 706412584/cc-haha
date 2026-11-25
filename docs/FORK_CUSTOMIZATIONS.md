# Fork 定制清单（Code Council Customizations Inventory）

> **用途**：上游合并时对照的唯一权威清单。每项含文件锚点与验证方法。
> **维护规则**：新增 fork 定制时同步登记；合并报告（`release-notes/merge-upstream-vX-report.md`）的「保护清单」节按本清单生成；发现合并丢失后必须把该项的锚点回填本清单。
> **最后核对**：2026-11-21（fork v0.9.1 基线与上游 v0.7.9 合并；本地验证细节见本轮合并报告）

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
| README.en.md 跟随上游内容性更新（上游英文版）：头部 NanmiCoder 徽章链接、上游自有赞助横幅（v0.7.5 Modelflare）**豁免/保留**；去广告锚点仅限 providerPresets.json；tokenUsage 分享图默认署名须指向 fork repo | `README.en.md`、`desktop/src/features/tokenUsage/useActivityProfile.ts:13` | `grep -c NanmiCoder README.en.md` 与 fork HEAD 计数一致即可；`grep 706412584 useActivityProfile.ts` 应为 1 |
| ★ Code Council wordmark | `desktop/src/components/layout/Sidebar.tsx:1146`（`Code <span>Council</span>`；AppShell.tsx 无 Council 字样，2026-10-28 核实） | grep `Council` Sidebar.tsx |
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
| Provider 编辑面板自定义请求头 textarea（写入 `env.ANTHROPIC_CUSTOM_HEADERS`,可覆盖 UA) | `desktop/src/pages/settings/ProviderSettings.tsx`(`readCustomHeadersFromSettingsJson` / `updateSettingsJsonCustomHeaders`) | `ProviderSettings.test.tsx`「provider custom request headers editor」4 例绿;5 份 locale 同步 `settings.providers.customHeaders*` |
| `SavedProvider.customHeaders` 持久化到 provider 数据（非默认 provider 也能存;`buildProviderManagedEnv` 写回 env 防 sync 覆盖) | `src/server/types/provider.ts`(3 处 schema)、`src/server/services/providerRuntimeEnv.ts`(return 末尾)、`desktop/src/types/provider.ts`(3 处) | `provider-runtime-env.test.ts` 3 例新测试绿 |
| ★ 探针携带 `customHeaders`：测试连接 / 获取模型直连上游（不经 proxy），白名单网关（agentrouter、xingchiapi）否则对**探测**假 401 而真实聊天正常；用户头覆盖 preset 头，凭据与 BLOCKED 头始终后写 | `src/server/proxy/upstreamHeaders.ts`(`parseCustomHeaderLines`)、`src/server/services/providerService.ts`(`testProviderConfig`/`fetchUpstreamModels`)、`src/server/services/providerModelCatalog.ts`(`fetchProviderModels`)、`desktop/src/pages/settings/ProviderSettings.tsx`(`handleTest`/`handleFetchModels`/`savedConfigUnchanged`) | `upstreamHeaders.test.ts` parseCustomHeaderLines 6 例、`providerService.test.ts` 4 例、`providerModelCatalog.test.ts` 2 例绿 |

## C. 会话存储 / 索引 / 历史

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| localIndex schema：fork 列（`thinking_enabled` 等）与上游列分叉时落在双方都空出的版本号；`is_team_worker` = v7，`openai_fast_mode` = v8（fork），`agent_profile` = v9（2026-10-28 v0.7.5 合并落号，双方 v8 均被占用） | `src/server/services/localIndex/migrations.ts:3,179,207` | `LOCAL_INDEX_SCHEMA_VERSION` 与列守卫（`hasColumn` 幂等） |
| boundedSessionHistory 12MiB 上限 + slimOversizedEntry | `src/server/services/boundedSessionHistory.ts:23,188` | grep `HISTORY_RETAINED_RECORD_BYTES` |
| sessionService.appendJsonlEntry：保留 fork `invalidateReadCache`，不做双写 | `src/server/services/sessionService.ts` | grep `invalidateReadCache`；确认无重复 appendFile |
| 会话右键菜单 Export JSONL / Copy path / Show in folder + 批量导出；与上游 Markdown 导出并存 | `desktop/src/components/layout/Sidebar.tsx` | `Sidebar.test.tsx` 与 `sessionMarkdown.test.ts` |
| 会话列表索引水合并发与 inspection 增量折叠：按文件路径缓存、stat/provider revision 作签名，追加只扫描新字节；OpenAI 当前账号窗口仍参与缓存签名 | `src/server/services/sessionService.ts`（`hydrateIndexedSession`、`readInspectionSnapshotForSession`、`inspectionSnapshots`） | `sessionService.sessionListPerformance.test.ts`、`sessionService.metadata.test.ts`、`session-context-provider-usage.test.ts` |
| 断电恢复：原子写入 fsync + snapshot，损坏 Provider 索引先从快照恢复身份，再写 settings owner，最后升级 schema | `src/server/storage/atomicWrite.ts`、`managedSettingsService.ts`、`persistentStorageMigrations.ts` | `atomicWrite*.test.ts`、`persistence-upgrade.test.ts` 的恢复与子代理 owner 用例 |

## D. 中转/断流韧性

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| 流断线重试墙钟预算 `CLAUDE_STREAM_TRANSIENT_RETRY_BUDGET_MS`（默认 60s）；watchdog 默认 4 次，transport/transient 沿用 API 默认 10 次，Codex tool-input watchdog 最多 1 次（v0.9.1 基线即如此） | `src/services/api/withRetry.ts:439-443`、`src/services/api/streamRetry.ts:83` | grep `getStreamTransientRetryBudgetMs`；`streamRetry.test.ts` 绿 |
| 流断线重试横幅（kind-specific 文案 + data-retry-kind） | `desktop/src/components/chat/StreamingIndicator.tsx` | grep `data-retry-kind` |
| `PENDING_PERMISSION_DISCONNECT_CLEANUP_MS` 保 5 分钟（上游为自动回答提到 31 分钟） | `src/server/ws/handler.ts:196` | grep 该常量 |
| Relay 透传 `User-Agent`（不剥 `claude-cli/...`,上游如星驰有客户端白名单） | `src/server/proxy/handler.ts:502`(`isInternalClientHeader` 不再匹配 user-agent) | `handlerUserAgentPassthrough.test.ts` 绿;opencode-go preset 仍可被 upstreamHeaders 覆盖 UA |
| 跨协议路径同样透传客户端身份（`openai_chat`/`openai_responses`/`gemini` 曾从空对象构造上游头,出站 UA 退化成 `Bun/x.y.z`;Anthropic 专有头与 `x-stainless-*` 仍丢弃） | `src/server/proxy/handler.ts`(`forwardClientHeaders(incomingHeaders, true)`) | `handlerUserAgentPassthrough.test.ts` 的跨协议用例绿;本地网关 `127.0.0.1:6789/panel/#logs` 应显示 `claude-cli/2.1.288 (external, cli)` |
| Stale-modelId guard（persisted 模型已不在任何槽位时回退 main,防上游 404）——**必须含 fable 槽**,回退值必须带 `[1m]` 标记,否则 catalog 解析抛 `SESSION_MODEL_UNAVAILABLE` | `src/server/ws/handler.ts`(`Stale-modelId guard` + `applyModel1mSupport`) | `websocket-handler.test.ts` 的 `stale runtime modelId guard` 两例绿;上游无此 guard |
| Relay 会话 ID 轮换（2026-11-21）：relay 按会话计数满 100 次返回 `400 session_request_limit_exceeded` 时，proxy 自动把发给上游的会话 ID 轮换为 `原ID-r{n}` 并重试一次，CLI 无感续跑。触发三重门槛：仅 upstreamHeaders 模板含 `$SESSION_ID` 的 preset（如 opencode-go）+ 恰为 400 + body 含精确错误码；轮换 ID 成功过→计满后继续轮换，从未成功就被拒→永久禁用该会话轮换（防按账号计数的 relay 双倍流量）；本地 trace/prompt cache 始终用原 ID；TTL 6h、每会话上限 25 次轮换、全局 1000 会话 | `src/server/proxy/sessionRotation.ts`（新文件）、`src/server/proxy/handler.ts`（`dispatchUpstream` 闭包 + 轮换重试块 + `markUpstreamSessionSuccess`） | `sessionRotation.test.ts` 12 例绿（含无关 400 不误伤、无模板不触发、禁用收敛三例）；grep `SESSION_LIMIT_ERROR_CODE`、`templateCarriesSessionId` 非零；上游无此机制 |
| Relay 历史裁剪（2026-11-25）：relay 返回 `400 session_turn_limit_exceeded` 时，proxy 按错误文案选择裁剪口径——"已满 20 轮对话"只数 `message` user 项（工具结果与 assistant 不计），裁到 19 条真实 user；"模型已回复超过 200 轮"实际按请求历史体积（实测 805KB 纯历史通过、带 tools/instructions 时 829-835KB 拒绝，约 20 万 token 级），按 250KB 模型可见文本（UTF-8 字节，含 base64 媒体）预算保留**最新**工具调用/结果与首条任务锚点（2026-11-25 深夜星驰把 200 轮口径收紧为 100 轮：实测 381KB 通过、572KB 拒绝，150 组工具调用被报成 105 轮——计数是按体积折算，不是项数）。窗口外活动压缩为 `Compacted earlier activity`（工具名/参数/结果前 500 字符，上限 32KB，不再整段丢弃）；窗口外真实用户指令合并为 `Earlier user instructions`（最多 64 条、每条 300 字符、上限 16KB，并过滤 task-notification/skill/local-command 等系统注入），防止模型丢失授权/任务切换而"失忆"；最新单条消息带超大截图时把媒体降级为占位而不是丢弃整轮；窗口内 tool_use 与 tool_result **双向**完全配对（孤立结果与无结果的调用都移除，否则 Anthropic/Responses 上游拒绝）；`system`/`tools` 等非 messages 字段不动；裁剪后重试一次。**预算可覆盖**：provider 的 `turnLimitTrimBytes`（providers.json）> settings.json 的 `env.CLAUDE_PROXY_TURN_LIMIT_BUDGET_BYTES`（桌面端 Settings→设置 JSON；每次拒绝时重读文件，改完下一次请求即生效）> 进程环境变量同名 > 默认 250KB。星驰再改阈值时改配置即可、无需新包。与会话 ID 无关（原/随机 `prompt_cache_key` 结果一致），轮换 ID 对其无效 | `src/server/proxy/historyTrim.ts`（新文件）、`src/server/proxy/handler.ts`（`dispatchUpstream` 增加 requestBody 参数 + turn-limit 重试块） | `historyTrim.test.ts` 25 例、`handlerTurnLimit.test.ts` 5 例绿；proxy 全套 253 pass；grep `TURN_LIMIT_ERROR_CODE`、`trimHistoryForTurnLimit` 非零 |
| 会话恢复中断通知明确主会话可用（2026-11-25）：应用/安装重启导致 session recovery 时，未完成的后台子代理会被标记 failed 并投递 task-notification；原文案只写 "interrupted during session recovery"，模型会误判为整个执行环境被暂停而停止操作工作区。修复后 error 与 notification summary 明确 "the main session and workspace are available; do not treat this as an environment pause. Re-run the subtask if it is still needed." | `src/tasks/LocalAgentTask/LocalAgentTask.tsx`（`restoreAgentRuntimeSnapshot` 的 interrupted task error 与 inbox notification） | `src/tools/AgentTool/agentToolUtils.test.ts` 的 "marks orphaned running Agents interrupted" 用例断言新文案；该文件 1 个预存在失败（`keeps start, progress, and terminal owned…`，与本次无关，stash 后同样失败） |

## E. 桌面 UX（fork-only / 改上游）

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| 四套经典主题（classic-white / classic-light / eye-care / classic-dark）与新增上游主题并存；CSS、启动脚本、主题集合、Agent Office 映射同时覆盖 | `desktop/src/theme/globals.css`、`desktop/index.html`、`desktop/src/types/settings.ts`、`desktop/src/components/agentOffice/officeTheme.ts` | `globals.test.ts`、`uiStore.test.ts`、`generalSettings.test.tsx`、`officeTheme.test.ts` |
| 手动 compact 动作（ContextUsage 弹出层 → `/compact` 走消息链） | `desktop/src/components/chat/ContextUsageIndicator.tsx:511-517` | grep `handleCompact` |
| Composer 能力菜单三个编排开关（coordinator / solo / re pipeline） | `desktop/src/components/chat/capabilityMenuModel.ts:60-63,451` | grep `toggleCoordinator`、`setPipeline` |
| ToolCallGroup：useEdgeAutoExpanded 边缘触发自动展开、isStreaming 状态、media-gen 内联画廊、20k 预览截断 | `desktop/src/components/chat/ToolCallGroup.tsx:81` | grep `useEdgeAutoExpanded` |
| 图片标注流：ImageAnnotationModal + authedImage 鉴权 fetch + annotate-and-ask 预填 + `-annotated.png` 兄弟路径过滤 | `desktop/src/components/chat/ImageAnnotationModal.tsx:4`、`desktop/src/components/chat/ChatInput.tsx:1217` | grep `fetchServerImageBlobUrl`、`-annotated.png` |
| Agent Office 入口：TabBar Building2 按钮 + AppShell modal + OFFICE_TAB_PREFIX 不算 session tab | `desktop/src/components/layout/TabBar.tsx`、`desktop/src/stores/tabStore.ts` | grep `OFFICE_TAB_PREFIX` |
| TabBar：双箭头槽位 unmount、滚轮横滚、team-member activity 守卫 | `desktop/src/components/layout/TabBar.tsx` | 合并 diff 目视 + TabBar 相关测试 |
| Material Symbols 字体类（自托管 woff2，防 21 个图标 span 渲染原始文本） | `desktop/src/theme/globals.css:4-12` | grep `material-symbols-outlined.woff2` |
| 文件树右键 WorkspaceFileTreeMenu + WorkspaceEditableFile（上游已删，fork 保留） | `desktop/src/components/workbench/WorkspaceFileTreeMenu.tsx`、`WorkspaceEditableFile.tsx` | 文件存在 + 对应测试绿 |
| 电源能力检测多层防御：Win32 probe 全 false 时回退 `powercfg /a` 解析；`idlePower.refresh` 在 capabilities 为 false 时先调 `refreshCapabilities` 重试；`idlePowerHost` 把 probe 错误写入诊断日志 | `desktop/electron/services/idlePowerPlatform.ts`(`detectPowerCapabilitiesViaPowercfg`)、`idlePower.ts`(`refresh` 开头)、`idlePowerHost.ts`(`onError` / `refreshCapabilities`) | `idlePowerPlatform.test.ts` 36 例绿（含 3 例回退）;`idlePower` 全套 88 例绿 |
| 聊天内容列宽 `var(--chat-content-max-width)`（不得回退到上游 800px 硬编码） | `desktop/src/components/chat/BackgroundTasksBar.tsx`、`SessionTaskBar.tsx` | grep `max-w-\[900px\]` 应为 0 |
| 设置 → 系统提示词页：主系统提示词**替换**（`--system-prompt-file`，与编排提示词的 append 通道区分）+ 载入内置默认快照 | `desktop/src/components/settings/SystemPromptSettings.tsx`、`src/server/api/system-prompt.ts`、`src/server/services/systemPromptPreferencesService.ts`、`src/constants/prompts.ts`（`getStaticSystemPromptSnapshot`）、`src/server/services/conversationService.ts`（`resolveSystemPromptFile`） | grep `resolvedSystemPromptPath`、`getStaticSystemPromptSnapshot`；`system-prompt.test.ts`、`system-prompt-api.test.ts`、`SystemPromptSettings.test.tsx` 绿。注意：上游合并时 `getStaticSystemPromptSnapshot` 是加法导出，若丢失则「载入内置默认」按钮静默为空 |

| 设置 JSON 自动回填密钥时排除 CLI 占位符（`proxy-managed` / `dummy`）：编辑 provider 对话框的 Settings JSON 会把 `env.ANTHROPIC_API_KEY` 回填到密钥表单，而走 proxy 的 provider 的 env 本来就是 `proxy-managed`；不排除则保存会用占位符覆盖 provider 真实 key | `desktop/src/pages/settings/ProviderSettings.tsx`（`CLI_MANAGED_API_KEY_PLACEHOLDERS` 与自动回填分支） | `ProviderSettings.test.tsx` 的 "does not copy the CLI proxy placeholder into the provider key field" 用例绿 |

## F. 服务端行为

| 定制 | 锚点 | 验证 |
| --- | --- | --- |
| media-gen 配置保存后热刷新：`PUT /api/plugins/media-gen/config` 保存后对所有活跃会话发 `reload_plugins`（每个最多等 15s），CLI 重新加载插件/MCP 并重建 `MEDIA_GEN_PROVIDERS_JSON`，新增/修改 provider 无需重启应用 | `src/server/api/plugins.ts`（media-gen config PUT + `refreshSession`）、`src/server/services/sessionComponentReloadService.ts` | `plugins.test.ts` 的 "PUT saves providers and refreshes running sessions so they apply without restart" 用例绿 |
| 权限请求重放 replayPendingPermissionRequests | `src/server/ws/handler.ts:917,5623` | grep 该函数 |
| MCP 会话热注入（handleToggle/Save/Reconnect/Refresh 传 activeSessionId）+ McpToolsTab + marketplace 浏览 | `desktop/src/pages/McpSettings.tsx:708` | grep `McpToolsTab` |
| Plugins 推荐目录 + URL 安装 + Configure 按钮（空列表不 early-return） | `desktop/src/components/plugins/PluginList.tsx:38-48` | grep `CATALOG_DESC_KEY`；`pluginsSettings.test.tsx` 绿 |
| Skills 推荐目录节 + 空已安装列表不 early-return | `desktop/src/components/skills/SkillList.tsx` | `skillsSettings.test.tsx` 绿 |
| chatStore 冷恢复对账 `applyKnownStoppedTasks(killStaleRunningTasks(..., confirmedActiveTaskIds), sessionId)`（loadHistory 与 reloadHistory 两分支都要） | `desktop/src/stores/chatStore.ts:4622,4753,5006,8028` | grep `applyKnownStoppedTasks` 应 ≥3 处 |
| fork 的 stop/disconnect 边界（与上游 #1501 进程回收共存）：stop settlement/输出栅栏、进程 `instanceId` 防误杀、上游自主前台 epoch 兼容 | `src/server/services/conversationService.ts`、`src/server/ws/handler.ts` | `websocket-handler.test.ts` 的重复停止、自主续跑、进程替换用例 |
| 团队中断计划恢复与 runtime-control 共存：仅本次人工确认的 resume 可在身份/revision 校验后重新授权 control；普通暂停团队追加成员不得绕过门禁 | `src/server/services/teamPlanService.ts`、`teamPlanRuntime.ts` | `teamPlanService.test.ts`、`teamPlanRuntime.resumeControl.test.ts` |
| H5 隧道：保留 named tunnel 独立域名、Token 本地格式验证、quick 新建入口隐藏及 Cloudflare/Pinggy 诊断链 | `desktop/src/pages/settings/GeneralSettings.tsx`、`desktop/electron/services/serverRuntime.ts` | `generalSettings.test.tsx`、`serverRuntime.test.ts`、`cloudflareTunnel.test.ts` |

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
