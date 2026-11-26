# Merge Report — upstream v0.7.9 → v0.8.0 into Code Council

> 状态：本地冲突解决和三轮审查已完成；合并尚未提交，完整验证未通过。不得据此宣称 PR-ready、push-ready 或发布就绪。

## 合并边界

- fork 基线：`9820ff926`（v0.9.6）。
- 上游基线：`abdcff54f`（v0.7.9，本地 tag `upstream-v0.7.9`；已确认是 fork 祖先）。
- 上游目标：`686f02f7c4`（v0.8.0，本地 tag `upstream-v0.8.0`）。
- 上游变更：21 个提交、300 个文件（约 +11,323/−2,420），包括桌面/H5/手机端 UI 重构、`/fast`、提示词优化、上下键历史、AskUserQuestion 图片/备注、内联音频、Grok 官方上下文窗口、网络风险提示开关、手机常亮与后台重连、Telegram 中途报错流修复、本地索引扫描风暴修复。
- 合并分支：`merge/upstream-v0.8.0`。`HEAD` 仍为 `9820ff926`，`MERGE_HEAD` 为 `686f02f7c`；没有生成合并提交。
- 用户原有两项未提交改动已恢复：`desktop/bun.lock` 删除 `fflate` 依赖行、`desktop/src-tauri/resources/preview-agent.js` 生成物差异。后者与 stash 中保存的版本一致；前者保留为相对合并索引的单行删除，不与上游新增依赖混淆。备份 stash `pre-merge-upstream-v0.8.0-user-worktree` 仍保留。
- `README.md`、`README.zh-CN.md`、`release-notes/v0.8.0.md` 未被上游覆盖。与 fork HEAD 比较时只有工作树 CRLF 与 Git blob LF 的物理换行差异，正文一致。
- 本轮未提交、未推送、未建 PR、未打包、未发布，也未调用真实模型。

## 冲突与融合结果

- 首次合并的 48 个冲突文件均已解决；`git diff --name-only --diff-filter=U` 为空。
- 主题：保留 fork 全部 11 套主题（含四套经典主题），不接受上游把已有主题迁移丢弃的行为；接入上游 `dark` 新底色 `#1B1A18`，启动脚本、CSS、系统主题解析保持一致。相应测试改为验证 fork 保留规则，而非删除产品能力以迎合上游断言。
- 设置：保留 `thinkingAutoCollapse` 与上游 `fastMode`、串行保存队列；服务端保留会话内容搜索停止逻辑，同时接入 `syncFastModeSettingToActiveSessions`。
- 聊天：融合 ModelSelector 的 docked effort/fast/permissions 与 thinking 切换；修复无 effort/permission 控件时 thinking 页脚被隐藏的接缝，新增回归测试。保留工具组边缘触发展开、媒体画廊和 20k 预览截断。
- ChatInput 保留图片标注并接入提示词优化、输入历史；删除合并产生的重复成员状态与重复附件 input，新增单实例回归测试。MessageList 保留 fork 卡片清理并接入 checkpoint error；AssistantMessage 接入内联音频。
- 工具图片：修复嵌套图片与同级图片的缓存索引顺序，新增缓存命中、图片顺序和原消息不变的回归测试。
- 权限响应：上游新增参数后，5 项旧测试的调用断言同步更新；没有改变测试输入来掩盖产品错误。
- 品牌：Sidebar 保留 `Code Council`；不改 fork README 与既有发布历史。

## fork 保护清单

依据 `docs/FORK_CUSTOMIZATIONS.md` A–H 核对文件锚点与合并差异。下列“保留”是源码/差异审查结论；测试覆盖与未通过项单列，不能等同于全部运行验证通过。

### A. 品牌与链接

- README.md / README.zh-CN.md 正文保持 fork HEAD；README.en.md 接收上游内容更新，NanmiCoder 出现次数保持 14；分享图默认署名锚点未改。
- Sidebar 的 Code Council wordmark 保留；新增 diff 中没有指向非 fork 同名仓库的 GitHub 链接（README.en.md 和历史报告按清单豁免）。
- 全库仍有基线既有的上游引用、测试夹具与来源/许可链接；本轮没有将其批量重写，也不宣称全库原始匹配为零。

### B. Provider 体系

- 5 个 deprecated 墓碑：teamorouter、xuanshuapi、fennoai、qiniuai、shengsuanyun 均保留；接口AI 可选，无 featured/推广信息；featured 预设为空。
- 预设文件正文未改，中性 promoText 未误删；relay 的 `get_channel_failed` / `api_error` 5xx 重试保留。withRetry 仅新增 prompt_optimize 请求来源。
- reasoning/thinking 双向透传、xhigh/max 档、官方 OpenAI/Grok 分支保留；Grok 分支接入上游上下文窗口配置。
- Provider compat/thinking/media 标签、自定义头编辑器、SavedProvider.customHeaders 持久化与探针携带请求头的路径保留；provider-contract 门禁通过，ModelSelector 与 ProviderSettings 定向测试通过。

### C. 存储、索引与历史

- localIndex migrations 与 boundedSessionHistory 正文未改：保留 fork schema 列、幂等守卫与 12MiB 上限。
- sessionService 保留 invalidateReadCache、按文件路径缓存与增量 inspection；相关 metadata、sessionListPerformance、session-context-provider-usage 单文件在 server 日志中通过。
- Sidebar JSONL 导出/复制路径/文件夹入口与 Markdown 导出共存。
- atomicWrite、managedSettingsService、persistentStorageMigrations 的恢复路径未被替换；atomicWrite 与服务端 persistence-upgrade 单文件通过，但完整迁移门禁另有失败，见下文。

### D. 中转与断流韧性

- 流重试墙钟预算及 streamRetry 实现保留；StreamingIndicator 的 kind-specific 文案和 data-retry-kind 保留。
- 权限断连清理维持 `5 * 60_000`；权限重放与 stale-modelId guard 保留，仍检查 fable 槽并使用 applyModel1mSupport。
- proxy handler、UA/跨协议头转发、sessionRotation、historyTrim 与恢复通知实现未改；250KB 默认裁剪、配置覆盖和窗口外压缩继续沿用 fork 基线。

### E. 桌面 UX

- 11 套主题及四套经典主题保留；CSS、index.html、主题集合与未改的 Office 映射共存。Material Symbols 自托管字体保留。
- 手动 compact、coordinator/solo/re 开关、工具组边缘触发展开/媒体画廊/20k 截断、图片标注鉴权与 annotated 图片路径保留。
- Office 入口与 tab/session 区分、TabBar 箭头槽位和滚轮横滚保留；TabBar 的 4 项失败已在合并前 HEAD 复现，不能当作本轮通过。
- WorkspaceFileTreeMenu、WorkspaceEditableFile 均存在且未改；电源检测回退链、聊天列宽变量保持 fork 实现。
- 系统提示词替换、内置快照导出和 provider Settings JSON 排除 proxy-managed/dummy 的逻辑保留；ProviderSettings 65 项通过。

### F. 服务端行为

- media-gen 配置保存后刷新活跃会话的路径未改，plugins 单文件通过。既有局限仍在：已连接插件 MCP 的启动环境未必因 reload_plugins 重建，不能据此保证所有配置立即生效；必要时仍需新会话/重启。
- 权限重放、MCP activeSessionId 热注入、McpToolsTab、Plugins/Skills 推荐目录与空列表入口保留。
- chatStore 的 loadHistory/reloadHistory 冷恢复对账保留；stop/disconnect 的进程实例与输出隔离保留，WebSocket handler 176 项通过，桌面聊天契约定向测试通过。
- 团队计划中断恢复与 runtime-control 路径未改，teamPlan 相关单文件通过。
- H5 named tunnel 独立域名、Token 格式验证、隐藏 quick 新建入口及诊断链保留；隧道运行时实现未改，未进行真实隧道连接验证。

### G–H. 保删除项与功能大项

- searchContentCommitWorker 未复活；强制 ToolSearch、pending tool UI、会话标签条/侧聊的保删除边界按三轮审查核对；未引入 sponsor featured 位。
- H 节 IM、定时任务、团队 API、语法高亮/diff、文件搜索、5 locale、自托管字体、Esc 暂停、后台代理上报、编排、团队记忆、H5/语音/媒体与游戏插件按 A–G 锚点核对；不把这一源码检查描述为全部端到端验收。

## 测试证据

### 已通过

- 三轮独立只读审查均已结束，第三轮结论 APPROVE；审查不能替代未通过的门禁。
- 延迟送达的中转与 provider 存储定向回归日志（任务 bwbbixt3v）确认：26 文件、619 pass / 0 fail，进程 exit 0；这是此前执行的补充证据，不表示重新跑过完整门禁。
- 最新桌面定向回归：9 文件、310 pass / 0 fail。范围：ChatInput.teamMember、ModelSelector、ModelSelector.fastMode、ProviderSettings、globals、systemAppearance、bootstrapScript、uiStore、persistenceMigrations。
- 桌面冲突回归集合（EmptySession、generalSettings、AssistantMessage.images、MessageList、composerAttachments）：旧执行为 636 pass / 4 fail，当前名称过滤复跑的 4 项全部通过；随后核对延迟送达的完整复跑日志（任务 b75nftism），确认同一集合 5 文件、640 pass / 0 fail，进程 exit 0。该集合已有完整通过证据，但不能代替整个桌面或完整离线门禁。
- `node desktop/node_modules/typescript/bin/tsc --noEmit -p desktop/tsconfig.json` 与 Electron tsconfig 类型检查均 exit 0。
- 权限断言修复后 WebSocket handler：176 pass / 0 fail。
- 桌面聊天与 Electron/TabBar 定向集合：7 文件、792 pass / 4 fail；其中 6 文件通过，4 项失败全部来自 TabBar。不能把整个集合标绿。
- 完整离线执行记录中 provider-contract 与 agent-flow 两条 lane 通过；agent-flow 覆盖首轮、工具允许/拒绝、工具/API 错误、中断、权限重放、流恢复与会话恢复。
- `git diff --check`、`git diff --cached --check` 均通过；无未解决 Git 冲突。

### 基线与失败归因

- TabBar 4 项失败：workflow-only activity、Agent Teams activity 分流、owned DAG/roster/member spawn 分流、team member transcript activity 隐藏。在 `git archive HEAD` 的独立源码副本中按原测试输入全部复现；基线为 `9820ff926`，副本位于 `D:/data/cchh/tmp/merge-v080-baseline-g4rxjB`。本轮未修改这 4 项输入来凑绿。
- vitest.config.ts 的重复 exclude 警告也是 HEAD 既有配置，本轮未改。
- chat-contract 重跑：handler 176/0；mock CLI 集成 166 pass / 1 fail，失败位于 afterAll 清理 Windows 临时目录的 EBUSY。桌面契约另行定向通过；整个 chat-contract 仍非通过。
- server-checks：存在 Windows 清理 EBUSY、直接启动无扩展名 CLI 的 ENOENT、不支持的文件名/符号链接，以及其他断言失败。新增 watcher 的两项失败可见 POSIX 夹具路径与 Windows resolve 后路径不一致；未进行 Linux 全量对照，其余未证实项仍标为未确认，不一概归为基线。
- agent-e2e：前两个 mock 场景通过，后续在 Windows 临时目录 EBUSY 清理处退出；未完成整条 lane。
- adapters：1050 pass / 21 fail，包含 WebSocket fixture 关闭超时；未对所有失败做基线证明，仍为失败。
- persistence-upgrade：issue-router 夹具带换行的 Windows 目录名报 EINVAL；另有主题迁移断言失败，主题定向修复后 50 项迁移测试已通过，但完整 lane 未重跑通过。
- 手机端 LF 原始夹具的 CRLF 双重转换失败已有基线对照；不据此推断整个 mobile 门禁通过。

### 完整门禁与未运行项

- 离线报告：`artifacts/quality-runs/2026-11-25T16-39-02-452Z/report.json` 及 logs。8 条记录中 2 passed / 6 failed；该轮早于部分定向修复，保留为历史执行证据，不篡改为最终全绿。
- impact-report 的阻塞原因是 CLI core 变更要求 allow-cli-core-change 标签及维护者批准；本轮没有添加标签、设置覆盖或绕过策略。
- 完整 check:desktop、check:mobile、check:native、check:docs、check:coverage 以及真实桌面/UI smoke 没有最终通过证据。前端/Electron tsc 与定向测试不能代替这些门禁；尤其 check:native 包含打包，本轮未执行打包。
- 真实模型、外部 provider、真实隧道和安装包验证均未运行。

## 恢复执行后的补充证据（2026-11-26）

- 用户最后明确要求：全部完成后提交 PR，等待必需 CI 全绿再合并，随后端到端冒烟与 UI 验收；不包含发布新版本。此前“没有提交/PR授权”的记录早于该消息，不能继续作为最新授权边界。CLI core 的维护者例外标签尚未收到明确批准，未添加，也未设置环境覆盖。
- 本机默认 Bun 是 1.3.14，而仓库 `packageManager` 与 CI 要求 1.4.3。指定版本安装在仓库外临时目录，仅对验证进程调整 PATH；未升级全局 Bun 或修改依赖。
- 同一 `ws-bridge` 关闭超时在 1.3.14 复现、1.4.3 通过；随后完整 adapters 为 **1071 pass / 1 skip / 0 fail**，更新此前 1050/21 的失败状态。
- watcher 新增测试只在期望值使用原生 `resolve`，不改变夹具输入和产品逻辑；修复后 reconciliationWatcher、coordinator、sessionProjector 三文件 **125 pass / 1 skip / 0 fail**。
- 发现并先红后绿修复实际融合问题：fork 的桌面无路径图片保留 `sourceFile` 供惰性读取，上游 AskUserQuestion 只序列化 `path/data`，会丢失提交图片。问答卡接收图片时复用 `composerAttachmentToPayload`，不改变共享附件层的惰性策略；新增提交/转对话两条真实粘贴回归。问答、输入历史、提示词优化、消息图片和附件集合共 **6 文件、161 pass / 0 fail**。
- 新增服务与上下文接线集合 5 文件 **43 pass / 0 fail**；前端与 Electron 类型检查通过，修改后的前端再次检查通过。
- Chrome MCP 实际渲染验收：桌面 824×623 下无路径图片粘贴→预览→选项/备注→提交，390×844 下图片/备注→转对话；捕获的权限响应均携带图片 data，终态正确，无横向溢出或框架错误遮罩。证据：`artifacts/v080-question-desktop.png`、`artifacts/v080-question-mobile.png`。使用真实组件/store、隔离传输捕获；不是完整 Electron/模型链路验收。桌面宿主模拟导致的初始化告警和一次错误模块探测 404 已单列，不宣称控制台全无错误。
- Bun 1.4.3 离线报告：`artifacts/quality-runs/2026-11-25T20-35-09-362Z/report.json`，**2 passed / 4 failed**；provider-contract 与 agent-flow 通过。chat-contract 为 handler176/0、mock CLI166/1（afterAll 的 Windows EBUSY）；agent-e2e 前四场景通过，team-runtime 收尾的所有进程已退出断言失败，整条未通过；持久化 lane 的 Windows 换行目录 EINVAL、mode 权限断言和旧 agent preset source 失败仍在。
- `project-session-history` 最后一项分组失败，以及 `inProcessRunner.resume` 的旧元数据来源失败，均已在合并前 `9820ff926` 独立 archive 副本复现。仅据此确认这两项基线，不把其他未确认失败一概归为基线。
- 提示词优化真实 server E2E 的 15 条业务断言完成后，仍在 Windows 沙箱根目录清理报 EBUSY；有限清理重试与目录线程释放未解决，试改和调试日志均撤回，保留失败而非静默忽略。
- 桌面完整 Vitest 和限并发复跑均因 `ERR_IPC_CHANNEL_CLOSED` 中断，无完整通过证据。手机端 typecheck 与 lint 通过（1 warning），测试 **1415 pass / 3 skip / 11 fail**，包含 CRLF、Windows file-URL 与模块 mock 失败，完整 lane 不通过。
- 服务端 Bun 1.4.3 完整复跑已结束：**935 文件、10617 pass、140 fail、61 个失败文件**；隔离复查标记 60 FAILED、1 FLAKY，门禁 exit 1。失败包括 Windows 无扩展名 CLI/shebang、符号链接/权限、EBUSY 以及未全部归因项，不把 1 次复查转绿当作通过。日志为本会话 `bfnoqn46w.output`，分类报告为 `artifacts/server-tests/flaky.json`。

## 后续阻塞

- 继续归因并处理尚未证明的失败，复跑受影响门禁；若走 PR，按仓库策略取得 CLI core 标签/维护者批准。
- 所有合并修复尚未统一暂存；暂存时必须精确排除用户原有锁文件删除与 preview-agent 生成物改动，不可 git add -A。
- 当前仍为“冲突已解决、审查已完成、验证未全绿的本地合并”。虽然后续 PR/合并方向已有用户要求，但前置验证和策略批准尚未满足，不宣称全部完成或发布就绪。