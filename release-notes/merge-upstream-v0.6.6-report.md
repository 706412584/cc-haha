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
| `check:server`(CI,Linux) | 未跑 | **2 个文件红,均属上游自带** | — | 见下 |
| `check:server`(本地,Windows) | 235 pass / 9 fail | 与基线相同的 9 个 | 相同 9 个 | 全部预存 |

> **注意**:上表的“修复前”是**只修 desktop 之后**的状态。CI 上的 `chat-contract-checks`、`provider-contract-checks`、`policy-enforcement`、`server-checks`、`desktop-native-checks`、`coverage-checks` 当时全部为红 —— 第一轮修复只跑了 `check:server` 与 desktop 单测,没有跑 `check:impact` 选中的其余 lane。补跑后又发现 3 个功能回归与 1 处重复声明(见下)。

剩余 15 个 desktop 失败与基线逐条一致,属预存问题(非本次引入):
`scripts/build-macos-arm64.test.ts`、`electron/services/serverRuntime.test.ts`、`SessionActivityPanel.test.tsx`、`ModelSelector.test.tsx`、`TabBar.test.tsx`、`AgentManager.test.tsx`。
server 侧 9 个失败同样与基线一致,归入 `docs/known-pre-existing-test-failures.md` 的根因 C(Windows symlink / EBUSY / 路径)。
这些 Windows 特有的失败在 Linux CI 上不出现。

### `server-checks` 最后剩下的 2 个文件(测试脚手架缺陷,非本次合并引入,已修)

两者与上游 `2f8d819d` **逐字节相同**,且在 Windows 与 Linux(WSL 实测)上都以同样方式失败 —— 但根因在**测试脚手架**,不在被测产品,因此**都不应进 quarantine**:

- `src/cli/print.sessionMessage.test.ts` —— 两处缺陷叠加:
  1. `Bun.spawn(..., { stdin: new Blob([input]) })` **在两种平台上都不向子进程投递任何字节**,于是 CLI 无 stdout,`stdout.trim().split('\n').map(JSON.parse)` 抛 `Unexpected EOF`。同参数改用真实管道即正常(Linux 实测:Blob → 0 字节,pipe → 168 字节)。改为 `stdin: 'pipe'` + `write()`/`end()`。
  2. `bin/claude-haha` 是 shebang 脚本,`Bun.spawn` 在 Windows 上无法直接执行(ENOENT)。按同目录两个兄弟测试已有的 `cliCommand()` 写法,在 Windows 上显式经运行时跑入口。
- `src/server/services/sessionReferencesPersistence.test.ts` —— 两处过期断言:
  1. 用例「collaboration cursors…」期望 130 轮分页走完,但上游自己的 `COLLABORATION_READ_MAX_PAGES = 8`(`4ed18f09` 引入)使单条 cursor 链最多 8 页 × 10 turn,随后以 `hasMore: false, historyComplete: false` 明示到达上限而非静默截断。改为按该常量断言「链式读取所服务的 turn 连续且为最新 80 条,并正确报告到达上限」。
  2. `longestCursor > 500` 已不可达:有了页上限,链在第一个存储页内就结束,内嵌的存储 cursor(实测 531 字符)根本不会出现。把该不变量移到真正产出它的层 —— 新增用例直接断言存储 cursor 的长度区间。

> 方法论教训:上一轮我把这两个文件判为「上游自带、应放行」。**「与上游逐字节相同 + 上游同样红」只能证明不是本次合并引入,不能证明不是 bug。** 二者实际都是可修的脚手架缺陷,修完在两个平台上都转绿。判定「不是我们的问题」之后,仍应问一句「那它是什么问题、能否修」。


### 修复清单(25 文件)

**A. 客观缺陷**
- `desktop/src/pages/ActiveSession.test.tsx`:合并时被重复插入 557 行(7 个 `it` 各出现两次)并多出一个 `})`,导致该文件**完全无法解析**——其 44 个回归测试(终端面板 / 工作区面板 / 后台任务)一个都未执行。已去重并恢复平衡,现 44 用例全通过。
- `src/server/api/sessions.ts`:`USAGE_ONLY_CONTROL_TIMEOUT_MS` **被声明两次**。重复声明使 `blankNonCode` 的输出无法解析,触发 `policy-enforcement` 的 dead-import 失败,并中断整文件扫描;修掉后 `check:server` 的通过文件数从 235 升到 473。
- `src/server/proxy/handler.ts`:删除未使用的 `resolveModelReasoningProfile` import。fork 刻意**无条件**透传 `thinking` / `reasoning_content`,而不是按 DeepSeek reasoning profile 条件化,故 import 是残留。
- `SkillPickerMenu.tsx`:能力菜单改取上游架构后成为孤儿(无 runtime importer),按 `componentReachability.test.ts` 指示删除,并清理 5 个语言文件中的 4 个专属 key。
- `ToolCallBlock.tsx`:清理上游 import/type 残留(`CircleStop`、`ContentStats`)。
- `capabilityMenuModel.test.ts`:补 fork 必需的 `orchestration` 字段。
- `PermissionDialog.tsx`:`resolveDefaultRuntimeSelection` 传参由上游的 `currentModel?.id` 改为 fork 签名要求的 `currentModel`(类型不匹配)。

**B. 真实功能回归(合并丢失 fork 逻辑,共 3 处,均已恢复)**
- `sessionRuntimeStore.ts`:`matchesCurrent` 恢复 `thinkingEnabled` 比较。该比较 fork 有、上游无;丢失后服务端 thinking 覆盖值变化不会被同步,桌面端显示过期状态。
- `src/server/ws/handler.ts`:恢复 `activeTurn.titleTurnNumber = titleTurnNumber`。丢失后第 3499 行的守卫比较永远失败,**fork 的润色标题生成功能完全失效**。
- `src/server/services/sessionService.ts`:恢复整个 `prePlanPermissionMode` 持久化(fork 17 处引用 → 合并后 0 处)。涉及 `SessionLaunchInfo` / `RawEntry` 类型、`resolvePrePlanPermissionModeFromEntries` 解析(`null` 作为“已还原”墓碑)、`createSession` 与 `appendSessionMetadata` 写入、metadata 投影输出(仅 launchInfo)、append-skip 比较。丢失后离开 plan 模式无法还原用户原本的权限模式。
- `Sidebar.tsx`:`handleManualRefresh` 移除冗余的 `refreshSessionsNow()` 调用。`syncIndexes()` 内部已包含 `fetchSessions()`,重复调用使每次手动刷新发出 2 次列表请求。

**C. 去广告策略补齐**
- `desktop/src/pages/settings/ProviderSettings.tsx`:删除为 `aruhub` 硬编码的赞助 logo 与 `aria-label="Sponsor"` 星标(上游新增,合并时遗漏)。
- `src/server/__tests__/provider-presets.test.ts`:上游断言赞助商元数据(AruHub `featured` + `?aff=`、Atlas Cloud `utm_` 链接、OpenCode Go `?ref=`),改写为 fork 去广告语义(无 featured 位、无推荐码)。

**D. 测试对齐**
- `AskUserQuestion.test.tsx` / `chatStore.test.ts`:新增 `substantiveSends()` / `ORCHESTRATION_FRAME_TYPES` 过滤。fork 的 `chatStore.ts` 在每个真实用户回合前必发 `set_coordinator_mode` + `set_pipeline_mode` 两条帧,上游测试的 `toHaveBeenCalledTimes(1)` 未预料到。
- `websocket-handler.test.ts`:上游断言“CLI 以纯 `No task found with ID` 拒绝时报告失败”。fork 刻意把它视为停止的目标态并收敛(`isBackgroundTaskAlreadyGoneMessage`,fork 独有),否则会重新点亮一个永远停不掉的按钮。
- `tabStore.test.ts`:列表参数断言改为上游的分组形态 `{ view: 'sidebar', perProjectLimit: 6 }`;`syncFromSessions` 用例改用 `setState` 预置(该 store 把 `setSelection` 的值视为未确认用户选择,`pendingRuntimes` 会拒绝被 transcript 覆盖)。
- `MessagePayloadRetention.test.tsx`:5000 行 Edit diff 用例单独给 20s 超时(本地约 2s,在负载较高的 CI runner 上越过默认 5s 上限)。
- `generalSettings.test.tsx`:Provider 保存用例对齐上游行为(失败时对话框保持打开并显示 inline `role="alert"`,而非关闭 + toast + `console.error`)。
- `TraceSession.test.tsx`:补回上游的 `renderReady(20)`,使第二次 revision/签名观察落在测试窗口内。
- `ProviderSettings.test.tsx`:协议文案对齐 fork 的 `local protocol translation` 措辞(`providerProtocolTranslation.test.ts` 为此有专门守卫);AruHub 用例改为去广告语义(无徽章、无 `?aff=`、无 signup 文案);OpenCode Go 用例去掉 `?ref=` 推荐码。

**E. 第二轮:会话子系统重合并后 CI 暴露的 8 个文件(commit `5aa756a9` → `22a42815` → `25efb892`)**

`server-checks` 在 `11498836` 上仍红 8 个文件 / 18 个用例。逐一对照 `2f0ef19d`(fork)、`2f8d819d`(上游)与合并版三方后,归为三类:

- **真实回归(3 处,均为“回植时把方法截断/写错”)**
  - `sessionService.ts` 的 `getMetadataProjection`:会话子系统整体取 fork 版时,上游这个**有界元数据折叠**从未回植,于是三个本不该解析整份 transcript 的读取口被指回 `readJsonlFile` —— `getSessionLaunchInfo` / `getSessionWorkDir` 会把整份文件读进内存(测试里 24 条 256 KB 记录即触发),`appendSessionMetadata` 为解析 repository 与跨占位文件搬运标题也要全读。已按上游实现回植单一折叠(经 `streamBoundedHistory` + `HISTORY_SEMANTIC_RECORD_BYTES` 流式读取,128 KB 元数据信封上限),并保留 fork 必须随投影携带的字段(`prePlanPermissionMode`、`thinkingEnabled`、`providerTransition`)。
  - 同一方法里的 `prePlanPermissionMode` 初版用了 `??`,**无法表达“已清除”**:`resolvePrePlanPermissionModeFromEntries` 对“没有条目”和“见到 `null` 墓碑”都返回 `undefined`,于是恢复用户原权限模式后旧值仍在,`getSessionLaunchInfo` 继续上报。改为显式判墓碑(与 resolver 自身契约一致)。
  - `sessionService.ts` 的 `searchSessionMetadata`:回植时被截成“只用索引,否则返回空”,丢掉上游的 JSONL 扫描 + 排序兜底。已补回。
- **测试组成错配(4 个文件,上游用例贴到了 fork 实现上)**
  - `src/server/__tests__/settings.test.ts`:保留了上游新增的 4 个用例,却保留了 fork 的 import 块 → `getDefaultMainLoopModelSetting` / `parseUserSpecifiedModel` / `getSonnet46_1MOption` 未定义。补回上游 import 块即可(89 pass)。
  - `src/server/services/localIndex/searchContentProjector.test.ts`(7 个用例):实现侧是 **fork 的批处理架构**(与本报告决策 2 一致),而上游追加的用例测的是上游独有的 `onBatch` / `onCommitStarted` 钩子(配套文件 `searchContentCommitWorker.ts` 未被采用)。恢复 fork 测试文件(11 pass)。
  - `src/server/services/localIndex/searchContentCoordinator.test.ts`(2 个):删掉上游那个测 worker 写锁合并的 describe(`d16aabcf` 引入,架构未采用),保留已回植的 `suggestSessions` 断言(20 pass)。
  - `src/server/services/localIndex/coordinator.test.ts`(1 个):上游 `9c88a5cc`(已有提交行的快照可继续服务)已被采用,故启动再水合后的状态是 `ready` 而非 `building`,更新该断言(51 pass)。
  - `src/server/__tests__/sessions.test.ts` 的 `readJsonlFile parse cache`(T1/T4/T5):该套件借 `getSessionWorkDir` 驱动 fork 的 `readJsonlFile` 解析缓存,而上游已把该读取口改走有界投影(`fs.open`,不是 `fs.readFile`),于是 T1/T4 断言在投影根本不做的读取上失败,T5 变成 0 === 0 的空转。三个用例改走仍在用 `readJsonlFile` 的 `getSessionMessages`,并给 T5 补回「确实发生过整文件读取」的前置断言,避免它以错误的理由通过。
- **测试脚手架缺陷(2 个文件,与上游逐字节相同,但可修)** —— 见上节。

> 第二轮的两个方法论教训:
> 1. 判“是否合并引入”必须用**合并版自己的 blob** 与两侧对照。我一度用主仓的 `HEAD`(即 `main`/fork)当“合并版”去比对,得出了相反的归属结论。正确做法是 `git -C <merge-worktree> rev-parse HEAD:<path>`,或直接跑三方矩阵。
> 2. **“与上游逐字节相同 + 上游同样红”只证明不是本次引入,不证明不是 bug。** 那两个文件实际都是可修的脚手架缺陷。

## 残余风险

- **手工混合的 60 个冲突文件没有等价的三方验证手段。** 无冲突文件已用 `git merge-file` 复算确认无误,冲突文件则依赖逐个人工判断。本轮已发现并修复 6 处回归(4 处 fork 行为丢失 + 1 处重复声明 + 1 处上游兜底被截断),**不排除其他手工混合处仍有未被测试覆盖的偏差**。这是本次合并最大的不确定性来源。
- **fork 行为丢失的模式值得警惕**:多处丢失都是“fork/上游在某个函数里多加了一个字段、比较或兜底分支,合并取了另一侧后该增量消失”。这类丢失不产生类型错误、不影响编译,只有对应测试才会暴露。建议后续合并时对 `sessionService.ts`、`ws/handler.ts`、`sessionRuntimeStore.ts` 这三个文件做 fork-vs-merge 的逐函数字段比对。
- **`sessionService.ts` 的回归尤其危险**:该文件在本次合并中整体取了 fork 版(6177 行),上游所有新增方法都要手工回植,任何一处漏掉或截断都只在运行时暴露。本轮已在其中发现 2 处(`getMetadataProjection` 整块缺失、`searchSessionMetadata` 兜底被截)。**建议下次合并对该文件做方法级清单核对**:先 `grep` 出上游侧的全部 public/private 方法名,再逐个确认合并版里存在且未被简化。
- `searchSessionMetadata` 的兜底路径现由 `sessionMetadataSearch.test.ts` 覆盖(2 pass),但 `getMetadataProjection` 目前只被 `sessionHistoryRecovery.test.ts` 的「不读整份 transcript」用例间接覆盖。建议补一个直接断言:元数据读取在超过 128 KB 信封时抛 `SESSION_METADATA_TOO_LARGE`,以及缓存按源版本失效。
- `ContextUsageDetails.tsx` 回植的 compact 按钮目前无专门单测覆盖(上游该子系统无此功能,`ContextUsageIndicator.test.tsx` 的 27 个用例全部通过,但不含 compact 交互)。建议后续补一个「compact 在 turn 进行中禁用、点击后发送 `/compact`」的用例。
- `ToolCallBlock.tsx` 上游 `liveStatsSummary` 的回退依赖 `34aa9d71` 的既有决策;若上游后续修复了第三方 provider 的 XML 退化问题,可考虑重新评估是否恢复。
- 本地(Windows)与 CI(Linux)的失败集合不同:本地 desktop 15 个 / server 9 个失败在 CI 上不出现,而 CI 的 desktop 1 个 / server 15 个失败在本地也不完全复现。**以 CI 结果为准**,本地跑测试只能用于快速定位。

## 恢复工作方式

```bash
git fetch origin
git checkout merge/upstream-v0.6.6
git pull
bun install && cd desktop && bun install   # 装依赖
# 按 check:impact 选中的 lane 全跑,不要只跑 desktop + check:server:
cd desktop && node ./node_modules/typescript/bin/tsc --noEmit
node ./node_modules/vitest/vitest.mjs run
cd .. && bun run check:server && bun run check:provider-contract \
  && bun run check:chat-contract && bun run check:agent-flow && bun run check:policy
# 全绿后:走 PR 合入 main
```
