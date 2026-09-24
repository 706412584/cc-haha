# 上游合并报告 — upstream v0.6.6 → fork

- **日期**: 2026-09-24
- **分支**: `merge/upstream-v0.6.6`
- **合并对象**: upstream `v0.6.6` (commit `2f8d819d`,tag `v0.6.6`)
- **fork 侧**: `2f0ef19d` (release: v0.6.7)
- **merge base**: `85e7f3a2`
- **合并策略**: **以 fork 为主,吸收上游优化;大改子系统以上游为基底回植 fork 定制点**

## 合并概况

- merge 触及 **1218** 个文件,其中 **380** 个进入合并提交索引。
- 冲突已 **全部解决**:`git diff --diff-filter=U` = 0,全仓无残留 `<<<<<<<` / `>>>>>>>` 标记。
- 括号/JSX 平衡自检通过(chatStore.ts 的朴素计数“不平衡”是字符串/正则/注释里的括号,fork HEAD 原版同值,非本次引入)。

## 关键架构决策(二选一/取舍)

1. **会话历史读取子系统** → **取上游分页架构**(`getSessionHistoryPage` / `recoverSessionHistory` / `historyComplete` 分页恢复),但**回植 fork 的 `thinkingEnabled` / `prePlanPermissionMode` 持久化字段**(handler.ts 有多处依赖)。desktop 侧 `getMessages` API 已被上游 `getFullHistory` / `getHistoryPage` 取代。
2. **搜索索引子系统** → **保 fork 批处理架构**,回植上游 `suggestSessions` 等特性(此前会话已定,本次保持一致)。
3. **Composer “+” 能力菜单** → **取上游 `ComposerCapabilityMenu` / `useCapabilityMenu` / `capabilityMenuModel` 统一架构**,并**把 fork 三个编排开关(协调者 coordinator / Solo / 逆向流水线 RE)作为 switch 行回植进共享 model**(`toggleCoordinator` / `setPipeline` action;lucide 图标 Share2/Target/Layers)。ChatInput 传入 `orchestration`;EmptySession 传 `null`(建会话前无 per-session 状态,与 fork 原行为一致)。删除了 fork 旧的内联 `SkillPickerMenu`/`+`菜单实现。
4. **文件树右键菜单** (`WorkspaceFileTreePane` / `WorkspaceFileTab`) → **整体取 fork 侧**:保留 `WorkspaceFileTreeMenu`(复制路径/绝对路径、加入对话、外部程序打开)与 `WorkspaceEditableFile`(读/编辑/split 切换,上游已删该组件)。
5. **ContextUsage 子系统** → **取上游重做版**(`ce87bb17` redesign、`467c1578` 删 caption、`31e6f7f6` 按用量填充、`c4219071` token 口径),**回植 fork 的手动 compact 动作**(`handleCompact` → `/compact` 走同一消息链,`hideDisplayContent` 隐藏气泡)。上游该子系统无 compact,属 fork 独有功能。
6. **Provider 设置页** → **取上游实现**(含协议切换选择器),**并补齐 fork 去广告策略**:删除上游为 `aruhub` 硬编码的赞助 logo 与 `aria-label="Sponsor"` 星标。

## fork 定制点保护清单(对照 CLAUDE.md,均已确认保留)

- README.md / README.zh-CN.md:未被上游覆盖,Code Council 品牌与链接完整。
- Provider preset:`teamorouter` / `xuanshuapi`(玄枢) / `fennoai` / `qiniuai` / `shengsuanyun` 保留 `deprecated` 墓碑;`jiekouai`(接口AI)可选、无广告。
- **上游新增赞助商 `aruhub` / `atlascloud` / `apismart`:剔除 `featured` 位与 `promoText`(经用户确认)**;`opencode-go` 去掉推荐码 `?ref=`。providerPresets 测试保留 fork 版(`featuredIds === []`)。
  - **如实说明残留**:`apismart` 仍保留 `apiKeyUrl`(值为 `https://www.apismart.ai`,无 `?aff=`/`utm_` 追踪参数,等同于 `websiteUrl`);`opencode-go` 仍保留 `promoText`(内容为“订阅后填入 API Key,即可获取并选择模型。”,属中性功能说明而非推广文案)。两者均不含推荐码或返利链接。
- `xhigh` 推理档:保留(源码多处存在)。
- relay 重试逻辑 `withRetry.ts`:`get_channel_failed` / `api_error` 5xx 保留(14 处)。
- `thinking` 透传:proxy 层与 `thinkingEnabled` 字段保留。
- Code Council wordmark:`Sidebar.tsx`(“Code <span>Council</span>”)、`AppShell.tsx` 保留。
- 全库 GitHub 链接指向 `706412584/cc-haha`。
- **fork 有意回退项(非丢失)**:`ToolCallBlock` 的 `liveStatsSummary` / `formatContentStats` 不恢复。fork commit `34aa9d71` 明确回退了上游 #823 与 #703/#707/#712/#751(pending tool UI),理由是这些改动会使第三方 provider 上的 `tool_use` 响应退化成 XML 文本块。

## 冲突解决明细

**实测冲突规模:`git merge-tree --write-tree 2f0ef19d 2f8d819d` 报出 465 个冲突文件**(此前记录为“~40 文件”,严重低估)。

其中上游改动 ≥15 行的冲突文件按解决取向分布:

| 取向 | 文件数 |
| --- | --- |
| 整体取 fork | 22 |
| 整体取上游 | 22 |
| 手工混合 | 60 |

无冲突文件已用三方合并(`git merge-file`)逐文件复算,结果与实际合并提交**完全一致**(deviation = 0),即无冲突部分处理正确。

**源文件**:`ChatInput.tsx`、`EmptySession.tsx`、`chatStore.ts`、`TabBar.tsx`、`WorkspaceFileTreePane.tsx`(取 fork)、`WorkspaceFileTab.tsx`(取 fork)、`ContextUsageIndicator.tsx`、`ContextUsageDetails.tsx`、`ProviderSettings.tsx`、`Sidebar.tsx`、`sessionRuntimeStore.ts`、`tabStore.ts` 等。
**能力菜单 graft 新增改动**:`capabilityMenuModel.ts`、`useCapabilityMenu.ts`(加 orchestration 支持)。
**server 测试**:conversation-service、local-index-session-parity、sessions、trace-capture、websocket-handler、connectorService、workspaceWatch、cliAdapter 等 — 正交用例合并,架构相关取对应已合并侧。
**JSON**:`src/server/config/providerPresets.json` 去赞助商广告字段。

## 验证结果(本次在新机实测)

环境:`bun 1.3.14`,`node_modules` 已就位(根 / `desktop` / `adapters`)。

| 检查项 | 修复前 | 修复后 | pre-merge 基线 | 判定 |
| --- | --- | --- | --- | --- |
| desktop 单测失败数 | 46 | **15** | 15 | 新增归零 |
| desktop 失败文件 | 17 | **6** | 6 | 逐一对应 |
| `tsc --noEmit` (desktop) | 2 错误(阻断后续分析) | **0 错误** | 0 | 通过 |
| `vite build` (desktop) | 未跑 | **通过** | — | 通过 |
| `check:server` | 235 pass / 9 fail | **235 pass / 9 fail** | 相同 9 个 | 全部预存 |

剩余 15 个 desktop 失败与基线逐条一致,属预存问题(非本次引入):
`scripts/build-macos-arm64.test.ts`、`electron/services/serverRuntime.test.ts`、`SessionActivityPanel.test.tsx`、`ModelSelector.test.tsx`、`TabBar.test.tsx`、`AgentManager.test.tsx`。
server 侧 9 个失败同样与基线一致,归入 `docs/known-pre-existing-test-failures.md` 的根因 C(Windows symlink / EBUSY / 路径)。

### 修复清单(21 文件,+362 / −1244)

**A. 客观缺陷**
- `desktop/src/pages/ActiveSession.test.tsx`:合并时被重复插入 557 行(7 个 `it` 各出现两次)并多出一个 `})`,导致该文件**完全无法解析**——其 44 个回归测试(终端面板 / 工作区面板 / 后台任务)一个都未执行。已去重并恢复平衡,现 44 用例全通过。
- `SkillPickerMenu.tsx`:能力菜单改取上游架构后成为孤儿(无 runtime importer),按 `componentReachability.test.ts` 指示删除,并清理 5 个语言文件中的 4 个专属 key。
- `ToolCallBlock.tsx`:清理上游 import/type 残留(`CircleStop`、`ContentStats`)。
- `capabilityMenuModel.test.ts`:补 fork 必需的 `orchestration` 字段。
- `PermissionDialog.tsx`:`resolveDefaultRuntimeSelection` 传参由上游的 `currentModel?.id` 改为 fork 签名要求的 `currentModel`(类型不匹配)。

**B. 真实功能回归(合并丢失 fork 逻辑,已恢复)**
- `sessionRuntimeStore.ts`:`matchesCurrent` 恢复 `thinkingEnabled` 比较。该比较 fork 有、上游无;丢失后服务端 thinking 覆盖值变化不会被同步,桌面端会显示过期状态。
- `Sidebar.tsx`:`handleManualRefresh` 移除冗余的 `refreshSessionsNow()` 调用。`syncIndexes()` 内部已包含 `fetchSessions()`,重复调用使每次手动刷新发出 2 次列表请求。

**C. 去广告策略补齐**
- `ProviderSettings.tsx`:删除为 `aruhub` 硬编码的赞助 logo 与 `aria-label="Sponsor"` 星标(上游新增,合并时遗漏)。

**D. 测试对齐**
- `AskUserQuestion.test.tsx` / `chatStore.test.ts`:新增 `substantiveSends()` / `ORCHESTRATION_FRAME_TYPES` 过滤。fork 的 `chatStore.ts:3876-3891` 在每个真实用户回合前必发 `set_coordinator_mode` + `set_pipeline_mode` 两条帧,上游测试的 `toHaveBeenCalledTimes(1)` 未预料到。
- `tabStore.test.ts`:列表参数断言改为上游的分组形态 `{ view: 'sidebar', perProjectLimit: 6 }`;`syncFromSessions` 用例改用 `setState` 预置(该 store 把 `setSelection` 的值视为未确认用户选择,`pendingRuntimes` 会拒绝被 transcript 覆盖)。
- `generalSettings.test.tsx`:Provider 保存用例对齐上游行为(失败时对话框保持打开并显示 inline `role="alert"`,而非关闭 + toast + `console.error`)。
- `TraceSession.test.tsx`:补回上游的 `renderReady(20)`,使第二次 revision/签名观察落在测试窗口内。
- `ProviderSettings.test.tsx`:协议文案对齐 fork 的 `local protocol translation` 措辞(`providerProtocolTranslation.test.ts` 为此有专门守卫);AruHub 用例改为去广告语义(无徽章、无 `?aff=`、无 signup 文案);OpenCode Go 用例去掉 `?ref=` 推荐码。

## 残余风险

- **手工混合的 60 个冲突文件没有等价的三方验证手段。** 无冲突文件已用 `git merge-file` 复算确认无误,冲突文件则依赖逐个人工判断。本次已发现并修复上述回归,但不排除其他手工混合处仍有未被测试覆盖的偏差。
- `ContextUsageDetails.tsx` 回植的 compact 按钮目前无专门单测覆盖(上游该子系统无此功能,`ContextUsageIndicator.test.tsx` 的 27 个用例全部通过,但不含 compact 交互)。建议后续补一个「compact 在 turn 进行中禁用、点击后发送 `/compact`」的用例。
- `ToolCallBlock.tsx` 上游 `liveStatsSummary` 的回退依赖 `34aa9d71` 的既有决策;若上游后续修复了第三方 provider 的 XML 退化问题,可考虑重新评估是否恢复。

## 恢复工作方式

```bash
git fetch origin
git checkout merge/upstream-v0.6.6
git pull
bun install && cd desktop && bun install   # 装依赖
cd desktop && node ./node_modules/typescript/bin/tsc --noEmit
node ./node_modules/vitest/vitest.mjs run
bun run check:server
# 全绿后:走 PR 合入 main
```
