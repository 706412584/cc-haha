# 上游合并报告 — upstream v0.6.6 → fork

- **日期**: 2026-09-24
- **分支**: `merge/upstream-v0.6.6`
- **合并对象**: upstream tag `v0.6.6` (commit `2c72df62`)
- **merge base**: `85e7f3a2`
- **合并策略**: **以 fork 为主,吸收上游优化;大改子系统以上游为基底回植 fork 定制点**

## 合并概况

- merge 触及 **1218** 个文件,其中 **379** 个进入本次提交索引。
- 冲突已 **全部解决**:`git diff --diff-filter=U` = 0,全仓无残留 `<<<<<<<` / `>>>>>>>` 标记。
- 括号/JSX 平衡自检通过(chatStore.ts 的朴素计数“不平衡”是字符串/正则/注释里的括号,fork HEAD 原版同值,非本次引入)。

## 关键架构决策(二选一/取舍)

1. **会话历史读取子系统** → **取上游分页架构**(`getSessionHistoryPage` / `recoverSessionHistory` / `historyComplete` 分页恢复),但**回植 fork 的 `thinkingEnabled` / `prePlanPermissionMode` 持久化字段**(handler.ts 有多处依赖)。desktop 侧 `getMessages` API 已被上游 `getFullHistory` / `getHistoryPage` 取代,测试中残留的 `sessionsApi.getMessages` 已批量改为 `getFullHistory`。
2. **搜索索引子系统** → **保 fork 批处理架构**,回植上游 `suggestSessions` 等特性(此前会话已定,本次保持一致)。
3. **Composer “+” 能力菜单** → **取上游 `ComposerCapabilityMenu` / `useCapabilityMenu` / `capabilityMenuModel` 统一架构**,并**把 fork 三个编排开关(协调者 coordinator / Solo / 逆向流水线 RE)作为 switch 行回植进共享 model**(`toggleCoordinator` / `setPipeline` action;lucide 图标 Share2/Target/Layers)。ChatInput 传入 `orchestration`;EmptySession 传 `null`(建会话前无 per-session 状态,与 fork 原行为一致)。删除了 fork 旧的内联 `SkillPickerMenu`/`+`菜单实现。
4. **文件树右键菜单** (`WorkspaceFileTreePane` / `WorkspaceFileTab`) → **整体取 fork 侧**:保留 `WorkspaceFileTreeMenu`(复制路径/绝对路径、加入对话、外部程序打开)与 `WorkspaceEditableFile`(读/编辑/split 切换,上游已删该组件)。

## fork 定制点保护清单(对照 CLAUDE.md,均已确认保留)

- README.md / README.zh-CN.md:未被上游覆盖,Code Council 品牌与链接完整。
- Provider preset:`teamorouter` / `xuanshuapi`(玄枢) / `fennoai` / `qiniuai` / `shengsuanyun` 保留 `deprecated` 墓碑;`jiekouai`(接口AI)可选、无广告。
- **上游新增赞助商 `aruhub` / `atlascloud` / `apismart`:按 fork“去广告”策略剔除 `featured` / `promoText` / `apiKeyUrl`(经用户确认)**;`opencode-go` 去掉推荐码 `?ref=`。providerPresets 测试保留 fork 版(`featuredIds === []`)。
- `xhigh` 推理档:保留(源码多处存在)。
- relay 重试逻辑 `withRetry.ts`:`get_channel_failed` / `api_error` 5xx 保留(14 处)。
- `thinking` 透传:proxy 层与 `thinkingEnabled` 字段保留。
- Code Council wordmark:`Sidebar.tsx`(“Code <span>Council</span>”)、`AppShell.tsx` 保留。
- 全库 GitHub 链接指向 `706412584/cc-haha`。

## 冲突解决明细(共 ~40 文件)

**源文件(6)**:`ChatInput.tsx`(14 块)、`EmptySession.tsx`(6)、`chatStore.ts`(9)、`TabBar.tsx`(8)、`WorkspaceFileTreePane.tsx`(取 fork)、`WorkspaceFileTab.tsx`(取 fork)。
**能力菜单 graft 新增改动**:`capabilityMenuModel.ts`、`useCapabilityMenu.ts`(加 orchestration 支持)。
**server 测试(8)**:conversation-service、local-index-session-parity、sessions、trace-capture、websocket-handler、connectorService、workspaceWatch、cliAdapter — 正交用例合并,架构相关取对应已合并侧。
**desktop 测试(20)**:含 ChatInput/EmptySession/TabBar/ActiveSession/Sidebar/ThinkingBlock/MessageList/chatStore/sessionRuntimeStore/tabStore/InstalledSkills/AppShell/TraceSession/ContentRouter/MessageList/generalSettings/providerPresets 等 — 均按“正交合并、架构对齐”处理。
**JSON**:`src/server/config/providerPresets.json` 去赞助商广告字段。

## ⚠️ 换电脑后必须做的验证(本机无法执行)

**本机未安装依赖(无 `node_modules`、无 bun),因此以下均未运行,务必在新机补做:**

1. `cd desktop && bun install`(或按项目包管理器),根目录同理。
2. **类型检查**:`bun run typecheck` / `tsc --noEmit`(desktop 与根)。重点看 graft 的 `capabilityMenuModel.ts` / `useCapabilityMenu.ts` / `ChatInput.tsx` 的 `CapabilityAction` 联合类型是否闭合。
3. **单测**:优先跑改动过的
   - server:`bun test src/services/connectors/cliAdapter.test.ts src/server/__tests__/local-index-session-parity.test.ts src/server/__tests__/websocket-handler.test.ts`
   - desktop:`ChatInput.test.tsx`、`EmptySession.test.tsx`、`providerPresets.test.ts`、`composerOverlayParity.test.ts`、`capabilityMenuModel.test.ts`、`sessionRuntimeStore.test.ts`、`chatStore.test.ts`。
4. **构建**:desktop 构建 + Windows 打包脚本(见 CLAUDE.md 的 ELECTRON_MIRROR 说明)。
5. 若测试红:先看是否为“上游行为已变、fork 测试未跟”而非合并错误。

## 未决/风险点

- `chatStore.test.ts` 里 `getFullHistory` 现有 234 处,`getMessages` 已清零;若上游 mock 结构与 fork 断言不完全一致,可能有个别用例需微调。
- `composerOverlayParity.test.ts` 断言两个 composer 都用 `<ComposerCapabilityMenu>` + `useCapabilityMenu` —— 已满足,但需实跑确认。
- 本地临时文件 `.merge-manual.txt`、`.merge-take-theirs.txt` 为合并分类清单,**未提交**(留在旧机,不影响新机)。

## 恢复工作方式(新机)

```bash
git fetch origin
git checkout merge/upstream-v0.6.6
git pull
# 装依赖 → typecheck → 测试(见上)
# 全绿后:git commit(如有修复) → 走 PR 合入 main
```
