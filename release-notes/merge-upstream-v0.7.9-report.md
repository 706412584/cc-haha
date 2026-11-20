# Merge Report — upstream v0.7.8 → v0.7.9 into Code Council

## 合并边界

- fork 基线：`b83b89b62`（v0.9.1）。
- 上游基线：`98c9c08ce`（v0.7.8）。
- 上游目标：`abdcff54f`（v0.7.9），本地保存为 `upstream-v0.7.9`。fork 自己的历史 `v0.7.9` 标签保持不变。
- 上游新增 116 个提交，416 个文件改动；首次合并 49 个文件冲突。
- 合并分支：`merge/upstream-v0.7.9`；拟用 fork 版本：`0.9.2`。
- README.md、README.zh-CN.md 和 fork 历史 release-notes/v0.7.9.md 保持 fork 原文。

## 上游主要内容

团队暂停/恢复与暂停时修改成员模型、Claude 官方用量、应用角标、会话 Markdown 导出、深灰主题、预览分隔条拖动、输出额度升级、图片请求压缩，以及 Provider 并发保存、计划模型切换、即时停止、Git/worktree 元数据、MCP 代理和 H5 路径规范化等修复。手机版本更新至 0.1.5。

## fork 保护清单

逐项依据 docs/FORK_CUSTOMIZATIONS.md 检查；本轮将清单遗漏的经典主题、原子备份、索引性能、团队中断恢复和 H5 Token 交互补入清单。

| 分区 | 保护结果与处理 |
| --- | --- |
| A 品牌与链接 | 两份 fork README 保持原文；Sidebar Code Council、desktop productName/homepage/publish 保留；README.en.md 接受上游内容性更新及其既有豁免；Issue 模板改用 fork 仓库链接。 |
| B Provider | 5 个墓碑、接口 AI 可选、无 featured 推广、K3/xhigh、thinking 双向透传、官方账号环境、compat/thinking 徽章和 customHeaders 持久化均保留。并发 mutation queue 与 fork 原子写入/修订号共存。 |
| C 存储与性能 | schema 9 与列守卫、12 MiB retained history、invalidateReadCache、单写 JSONL、索引水合并发、inspection 增量折叠/LRU/stat+Provider 签名保留；JSONL 与新增 Markdown 导出并存。 |
| D 韧性 | get_channel_failed/api_error 重试、60 秒墙钟预算、watchdog 默认 4 次、跨协议 UA、Fable/1m stale guard、5 分钟权限断线清理和重试横幅保留。transport/transient 默认 API 10 次为合并前既有行为，未顺带改变。 |
| E 桌面 | compact、编排开关、工具分组/20k预览、图片标注与 blob CSP、Office/TabBar、Material Symbols、工作区右键、idlePower 和主系统提示词替换链保留；经典主题 CSS 从历史原实现恢复，与上游深灰主题共存，Office 补齐映射。 |
| F 服务端 | 权限重放、MCP 会话热注入、Skills/Plugins 推荐目录、chatStore 两条冷恢复对账、停止 settlement/输出栅栏与进程身份保护保留，并整合自主前台 epoch。H5 named tunnel、格式验证、quick 入口隐藏和诊断链保留。 |
| G 保删除 | searchContentCommitWorker、被撤回的 pending-tool UI/强制 ToolSearch 和 Provider sponsor featured 均未复活。 |

## 合并决策与发现

1. Proxy 所有跨协议分支同时传递原始请求头与下游 AbortSignal，保留身份透传并支持上游取消。
2. Provider 并发更新保留 customHeaders、thinking compatibility、revision 与导入的 usageScript。补入 ANTHROPIC_CUSTOM_HEADERS 托管键，清空时不再留有旧环境值。
3. 停止回收同时检查 fork 进程 instanceId、旧回合栅栏和上游自主前台 epoch，避免杀掉切换模型或自主续跑后的新回合。
4. settingsService 接受上游 General 偏好备份后补回 fs/promises 依赖，修复清除偏好时报 ReferenceError。
5. inspection 保留 fork 增量读取与缓存结构，接入当前 OpenAI 账号的 context window 和缓存签名。
6. 普通子目录按上游 explicitProjectRoots 分组，保留 fork 命名 Agent worktree 与嵌套内部 worktree 兼容例外。
7. 新增上游测试与 fork 行为冲突时明确测试契约：Provider 编辑递增 revision；思考增量经 fork 50ms 缓冲后断言；不回退这些运行时行为。
8. 文档发布测试逐个登记 9 个既有 fork 单语页面，同时继续要求其存在；上游正式文档保留完整双语/元数据断言。读取 Markdown 时统一 CRLF，避免 Windows frontmatter 留在正文。
9. 三轮独立审查完成：第一轮定制清单，第二轮服务端跨层，第三轮桌面接线。第二轮确认 Provider 快照恢复与 settings owner 的顺序问题，已新增失败回归再修复。团队中断恢复在同一生命周期锁中重验 durable 审批身份/revision，仅本次已确认 resume 重新授权 control；普通追加和锁等待期间撤销均继续拒绝。新增 3 项离线回归通过。

## 已取得的本地证据

- Provider/子代理模型/WebSocket 焦点：209 pass / 0 fail。
- UA 透传、Abort、重试与 Provider runtime env：145 pass / 0 fail。
- 新增自主停止和进程替换回归：2 pass / 0 fail。
- Provider 并发：11 pass / 0 fail。
- 设置与迁移初轮修复：152 pass / 0 fail；补 Provider 快照 owner 回归后迁移单文件 40 pass / 0 fail。
- 主题定向 7 文件 413 pass；补覆盖后 2 文件 55 pass。
- 桌面关键 7 文件 410 pass / 1 fail；失败是思考缓冲时序契约，修复后即时停止+Office 7 pass。
- Agent-flow：9 个真实 Server + mock SDK CLI 场景全部通过，无真实模型调用。
- 文档站构建、111 页/383 本地链接与资源检查通过；站点测试 47 pass / 0 fail。
- 原生 Rust 核心 1511 pass，以及 20/50/5/177/1 项专项测试通过；后续 sidecar 与 compiled smoke 49 pass / 2 skip。
- 398 个变更 JS/TS 文件语法解析通过；desktop lint 和 Electron TypeScript 检查通过；renderer 与手机版 H5 生产构建完成。
- 6 个最终 Electron/主题定向文件：437 pass / 0 fail。
- 中断团队恢复新增 3 pass；既有评审提交竞态单独验证 1 pass；同组批量运行曾有一次计划落盘时序失败，未抹除该记录。

以上为分批证据，不代表完整门禁全绿。最终提交/CI/打包结果以本报告后续收尾记录为准。

## 本地限制与未通过项目

- Windows 全量 Server/IM/手机测试包含 extensionless bin/claude-haha 直接执行、POSIX 路径和符号链接、WebSocket close/子进程退出时序等失败。未合并基线复现了 H5 SDK close、issue-router 换行目录 EINVAL、macOS app 枚举等类别。
- 首轮完整 verify 在桌面仍整合时读取到冲突，已终止失效运行；未将其记为通过。桌面/Electron 默认 worker 大套件发生 ERR_IPC_CHANNEL_CLOSED，改用 2 个 worker 重跑相同范围后仍发生通道关闭，完整套件未获得完成结论；未删改测试路由。
- contracts 实际执行报告：`artifacts/merge-v079-contracts/2026-11-20T21-15-38-229Z/report.md`；其中 Agent-flow 通过，其余失败日志保留，部分错误已在后续焦点回归修复。
- 浏览器组件画廊确认 neutral-dark / classic-dark 切换和 CSS 值、无 Vite overlay；画廊有横向溢出且无后端导致 runtime-control fetch 失败，不能据此声称手机正式布局或团队端到端通过。
- desktop-ui-smoke 因未安装 agent-browser 明确 skipped；未安装额外浏览器依赖，改用已有 Chrome DevTools 做有限主题交互检查。
- 覆盖率门禁已启动，但长时间无报告，且与完整 server lane 重复执行大型根测试；停止该重复运行，状态记为未完成，不能声称覆盖率通过。
- IM 本地套件：1047 pass / 1 skip / 21 fail，失败含 WebSocket fixture close 的 500ms 超时；未将其记为通过。
- 未运行真实 Provider/付费模型测试。未修改 quarantine、覆盖率阈值、分支保护或仓库设置。

## 清理与发布顺序

旧 v0.7.8 合并本地分支/worktree 已不存在；清理旧 unpacked 和重复 Electron 输出，将旧 v0.9.0 安装包保存在 desktop/build-artifacts/windows-x64-v0.9.0。独立 MCP PR worktree 未动。

按用户本次授权：本地验证 → 提交并合并 PR → 本地 Windows 打包 → 用户验证通过 → 才创建 tag / 远程 Release。用户验证前不发布远程版本。
