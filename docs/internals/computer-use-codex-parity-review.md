# Computer Use ↔ Codex Parity 评审结论（2026-07-27）

五个独立评审员 + 三轮交叉验证的结论汇总。取证以**明文为主**：Codex 活体 MCP `tools/list`、`@oai/sky` 的 JS/`.d.ts` 明文、以及二进制符号面。

> **取证方法论（后来者必读）**
> `strings` 对 Swift 二进制是**单向**证据：**命中 = 有效正证据；未命中 = 零证据，不能反证**。
> 原因是 Swift small-string 优化把 ≤15 字节的**字符串插值片段**内联进 String 结构体，不进 `__cstring`。
> 但**不能用字节数预测**"该不该找到"——`get_app_state`(13B) 作为独立 token 照样可见，因为 `__cstring` 还收
> ObjC selector / C 字面量 / Codable CodingKeys / 反射字段名，这些不走 small-string 优化。
>
> **最好的取证路径不是二进制**，是这里的明文：
> `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/`
> —— `targets/mac/*.js`（policy / telemetry / errors / window_result / native-pipe）、`types/window/*.d.ts`、`client.d.ts`。
> 策略文档双份：`plugins/computer-use/skills/computer-use/SKILL.md` 与 `.codex-plugin/computer-use-node-repl.md`。

---

## 1. 结论

| 层面 | 完成度 |
|---|---|
| **操控内核**（Codex 的 `ComputerUseMCPServer`） | **85–90%** |
| **Codex CU 整体产品** | **45–55%** |

Codex 的 client 二进制 multiplex **至少 4 个** MCP server：`ComputerUseMCPServer` / `EventStreamMCPServer` /
`ComputerHistoryMCPServer` / `MessagesMCPServer`。我们实现了第 1 个。

**回合内的操控行为与 Codex 零差距**（双方都是零隐式快照 + 每动作活体重解析）。
全部差距集中在跨回合轴、以及内核之外的产品面。

---

## 2. 归档中被证伪的表述（改归档时照这里改）

| 归档说法 | 实际 | 证据 |
|---|---|---|
| §2.1 变更工具返回体 = 重跑一次 `get_app_state` | **错**。Codex 8 个动作全返回 `Promise<void>`，文档写"做完动作再取状态"。**我方固定回执是对的** | `client.d.ts`；`sky-window-api.md:12-24`；回执串在 svc strings 逐字命中；`window_result.js` 只被 `get_app_state.js` 引用 |
| §2.2 Codex 9 个原生工具，`select_text` 是第 10 个补的 | **错**。Codex 原生就是 10 个，`select_text` 排第 6 | 活体 `tools/list` |
| §2.4 `element_index` Codex 发 string（内容是数字） | 类型确是 string，但**取值是裸整数** | `Element index to click`；node_repl `element_index: 42` |
| §5.3 Record & Replay 是"第三个" server，共 3 个 | **至少 4 个**（漏 `ComputerHistoryMCPServer`、`MessagesMCPServer`）。"恰好 4 个"不可证伪 | mangled 类名 |
| §5.3 per-app 指令"字段有了内容要自己喂" | **过时**。v1 就有 Safari/Finder/Electron 三份真内容 + 分类器 + 单测，投递格式与 Codex 逐字一致 | `AppGuidance.swift`；`window_result.js` |
| §5.3 / §6 elicitation 是"隐藏前置，没查过 SDK 支不支持" | **已解除**。SDK 1.29.0 双向全支持，零升级成本 | `sdk/dist/esm/server/index.js:351,394`；`types.js:335-345`（`{}`→`{form:{}}`） |
| §6 "Codex 用 XPC 我们用 socket" | **半对**。Codex 同一服务同时接受 XPC（Swift 面）和**帧长前缀 socket**（JS 面），后者与我们同类。严重度降级 | `nm -u` XPC 符号；`native-pipe.d.ts` |
| §4 判决一 读树必须置前 | 与我方代码里的新判决**正面冲突**，见下方 §5 未决项 | `AXTree.swift:230-241` |
| §1.2 glide 阻塞点击 500ms | **已修**（现为有界 0.1s，且仅目标 frontmost 时付） | `OverlayPolicy.swift:36-52` |
| §1.2 `screenshotFiltering` 谎报安全模型 | **已成死代码**（darwin 不走 legacy 面，win32 拿不到 `'native'`） | `common.ts:59-81`；`mcpServer.ts:307-313` |
| §1.2 无 UI-settle，命令一到就拍 | **至今成立**，见 §4 | `Capture.swift:434-452` |

---

## 3. 一处必须记住的我方优势（别被"优化"掉）

**零隐式快照能安全成立，靠的是每次动作都做活体重解析，而不是缓存 AX 引用。**

`AXTree.refetch(pid:index:)`（`AXTree.swift:453`）从**活体 root 重走一遍 path**，绝不复用快照时的 `AXUIElement`，
并校验语义指纹。配合 `guardStaleness`（`CommandRouter.swift:1369`，6 个动作入口全调）的四层前置守卫，
**失败模式是"带可执行提示的硬报错"，不是"静默点错"**。

指纹比直觉严得多（`ElementFingerprint.swift`）：
- 指纹 = `{role, subrole, identifier, title, valueKind}`，**`title` 原值参与比对**，只有 `value` 降级成"种类"
- 路径每一跳存**该层全部兄弟的指纹数组**，重解析要求整个数组逐个相等
- `SnapshotPathStep.init?` 要求被选中的指纹**在兄弟中唯一**，否则定位器**在快照时就建不出来** —— 歧义情形不留到动作时

⇒ 任何"把 `refetch` 换成缓存 AX ref 以提速"的改动都会摧毁这条保证。

另外 `sessions[pid]` **只由 `get_app_state` 写**（`AXTree.swift:217`），所以**模型手里的树与 daemon 的快照永远是同一帧**，
这是构造性保证——"拿着 3 个动作前的树去点、而 diff 只报相对上次查询的变化"这种错配**结构上不可能发生**。

---

## 4. 缺口（按是否阻塞核心操控分组）

### 阻塞核心操控（2 条）

1. **无 post-action UI settle**。Codex 有 `needsUISettleBeforeSkyshot`（动作后等 ~1s，有 loading indicator 时更久
   —— ⚠️ 具体时长来自 node-repl 文档的转述，**未被独立证实**；机制本身由符号名坐实）。

   > **两位评审员对这一项的严重度判定不同，此处不抹平：**
   > 一方列为"阻塞核心操控"；另一方判**中**而非高，理由是——正因为我们和 Codex 一样不自动重拍，
   > 模型的 `get_app_state` 是一次独立 MCP 往返，天然隔着几百毫秒到数秒的模型延迟，**顺带**提供了大量 settle 时间，
   > 所以不像归档 §1.2 描述的 v0 那么致命。但那是**附带效果不是保证**，覆盖不了"模型恰好在动画/加载中途发问"。
   > 反过来说：Codex 同样用固定回执，却**仍然**保留了 `needsUISettleBeforeSkyshot` —— 说明 OpenAI 不认为模型往返足够。

   我方 `get_app_state` 路径零 settle：`settleUntilNonShell` 是**读树前的 AX warm-up**（且对已证明未变的进程直接跳过），
   `Capture.windowShot` 前无任何等待。
   ⚠️ 与下面这条是**同一件事放错了层**，应一次改完：
   `AXAction.swift` 每次成功动作后 `Thread.sleep(0.15)`（全文件 11 处），而 `AXAction`/`CommandRouter` 都是 `@MainActor`
   —— 违反本仓库自己的 AX 线程红线；且其注释理由（"下一次由 router 自动重拍的 get_app_state 会反映变化"）
   **已被证伪**（router 不重拍了），现在是纯死成本 + 卡光标动画。
   → 正解：删动作后的 `Thread.sleep`，把等待搬到 `get_app_state` 截图之前，做成自适应，用 `Task.sleep`。

2. **`permissionsPending` 无重轮询**。Codex 是一等错误码 `-10014` 配「Do not end your turn yet, just call this tool again.」；
   我方返回终止性错误 + fire-and-forget 弹卡片 ⇒ **用户点完授权那一刻，模型这一回合已经放弃**。改一句 prose 即可。

### 跨回合（唯一比 Codex 差的轴）

3. **无 TurnEnded 协议**。Codex 有 kill switch：「Computer Use is unavailable because the current turn ended.」
   我方 diff epoch 只认 (proven 进程身份, key window ID)，**不认回合、不认用户手动操作**。
   必然踩中的场景：模型查树 → 回合结束 → **用户自己操作 5 分钟**（同窗口同进程）→ 新回合再查 → epoch 仍复用 →
   模型收到相对 5 分钟前那一帧的 diff，而**那个基线的全文它已经不在上下文里了**。
   ⇒ 损害是「**diff 基线模型看不见**」+「无越回合防护」，**不是**「会点错」（点错被 §3 的守卫挡住）。
   **廉价缓解（先做这个）**：Codex 在 node-repl 文档里教模型自我管理——
   *"If you disregard the text from a previous call to get_app_state… get the full tree next time you inspect AX text."*
   我方 `disableDiff` 的描述里没有任何"何时该传 true"的提示。**补一行 prose 覆盖最常见症状**，成本远低于跨三层协议。

### 产品面（不阻塞操控）

| 项 | Codex | 我方 |
|---|---|---|
| 确认策略四档 | **两个表面各一份完整 prose**（SKILL.md + node-repl.md） | **0/4**。9 道 gate 全在管"谁能被操控"，没有一道管"这个动作多危险"——点「删除账号」和点「刷新」等价 |
| 结构化 `risk` | `high\|low`，**按 app 判定**（输入只有 bundleID + urlDomain），只影响弹窗措辞与 persist 档位 | 无 risk 维度；只有 always 档没有 session-only |
| 遥测 | 两层：Swift 4 个 `time_*` + JS 4 个 Statsig 事件 | 0/8，只有 `error_kind` |
| node_repl 脚本面 | 模型写 JS **一次调用批量执行多动作** | 一动作一次 MCP round-trip（token/延迟量级差异） |
| Guardian | 11 个类（锁屏/密码框识别/自动解锁/URL 黑名单/SSRF） | 1/11（只有物理输入让位） |
| Skysight 记忆 | event stream → 10min/6h LLM 摘要 + sticky-taint 注入边界 | 0 |
| 截图传输 | `file://` URL | base64 内联（+33%） |
| 光标 raster | 45 帧 PNG | 加载器齐、0 帧、走 procedural（**刻意**，45 帧是 OpenAI 版权素材） |

> **确认策略四档可以纯 prose 落地** —— Codex 自己就是这么做的，四档判定 100% 由模型读 prose 完成，零代码支撑。
> 那个结构化 `risk` 撑不起四档，也不是为四档设计的。加结构化风险引擎属超出 Codex 的自选加固。

### 性能

**批量读 API 零使用**。Codex 导入 `AXUIElementCopyMultipleAttributeValues` / `CopyAttributeValues` / `GetAttributeValueCount`；
我方全部属性读经单一漏斗 `rawAttribute()`（`AXTree.swift:1832`），**一属性一次跨进程 IPC**，
实测 **22–35 次/元素**，满树（cap 1500）单次 `get_app_state` 可达 **3–5 万次 AX 调用**。
好消息：漏斗单一，改造面收敛在一个函数。

---

## 5. 唯一「判错则整套架构归零」的未决假设

`AXTree.swift:230-241` 断言「Codex 读树**不**置前，`enableEnhancedAX` 才是真触发器」，据此删除了 `running.activate(...)`。
这与归档 §4 判决一的真机实测（VS Code 后台 19 个壳元素 → 置前 225 个）**正面冲突**。

若后台确实读不到全树，则 `get_app_state` 返回的是空壳树，模型按 index 点什么都点不到 —— **整个语义循环的前提不成立**。

**验证成本极低**：用安装版 `.app` 对同一个 Electron 应用前台/后台各跑一次 `get_app_state`，比较 `elementCount`。
见 `computer-use-native-manual-qa.md` §2.1–2.2。**这条应排在所有其他工作之前。**

（旁证但不足以定论：Codex 有 `activate*` 选择器并监听 `NSWorkspaceDidActivateApplicationNotification`，
但也可能只服务它自己的授权窗口——**未证实**。）

---

## 6. Parity 缺陷（修法明确）

| # | 问题 | 修法 |
|---|---|---|
| 1 | `select_text` 参数名：Codex MCP 面是 **`selection`**，我方是 `selection_type`。缺 `additionalProperties:false` ⇒ 模型按 Codex 契约传 `selection` 被静默吞 → 回落默认 `"text"` → **选中文本而非放光标，零报错** | 官方名改 `selection`，`selection_type` 留作别名（有 Codex JS 门面背书），走现成的 `rejectAliasConflict`。现有三处测试一字不用改 |
| 2 | **10 个 schema 全缺 `additionalProperties:false`**（Codex 10/10 都有）—— 这是 #1 的**放大机制**，也是下一个同类问题的温床 | 全部补上；补前确认每个别名都已在 `properties` 里声明 |
| 3 | **10 个工具全缺 `annotations`**。Codex：`list_apps`/`get_app_state` = `readOnlyHint:true`+`idempotentHint:true`；其余 8 个四个 hint 全 false；`openWorldHint` 全 false | 照抄 |
| 4 | **4 个模型可见字段跳过 `sanitize`**：`Help:` / `Description:` / `ID:` / `Window:"…"` 头行。其中 `labelFieldText` **算了 `sanitize()` 却没用**（只拿去比对链接前缀，输出用原串）。后果：app 把 AXDescription 设成含 `\n\t` 的串即可**伪造带假 handle 的树行**（缩进是唯一结构信号），且这 4 个字段也无 160 截断 | 恢复调用。注意：这不是"要不要向 Codex 看齐"的问题——`AXTree.swift:34` 与 `:1694` 是**我方自己声明的格式契约**，加固=恢复自洽 |
| 5 | app 专属指令**未按 app 去重**，每次 `get_app_state` 重发。而 `AppGuidance.swift:15-17` 的 Swift 注释**已承诺**"TS 在该 app 首次注入" | 按 bundleId 去重（Codex 两个门面都这么做） |
| 6 | `tools.ts` 把 `disableDiff` 描述成 "a cumulative diff against the previous snapshot" —— **语义矛盾**（cumulative 的基准是 initial 不是 previous），且 Swift 只实现了 previous-diff | 改措辞。**注意**：previous-diff 就是 Codex 文档化的默认行为，我方实现是对的，**不需要**去实现 cumulative |
| 7 | 拒绝文案代入值：Codex 代入 `bundleIdentifier`，我方代入模型输入的名字。另 Codex 有第二档"组织策略"拒绝 | 低优先 |
| 8 | 边界比 Codex 严：`click_count`≤3、`pages`≤10、坐标 `minimum:0`（Codex 无上限） | 会拒绝 Codex 会接受的调用，按需放宽 |

---

## 7. 刻意偏离（保留，但必须记档而非默默留着）

**`element_index` 用不透明句柄 `g<epoch>:<id>`（如 `g17:4`），Codex 用裸整数。**

- **保留理由**：陈旧整数会**静默**指向"现在占据那个位置"的别的元素；我方 epoch 前缀让它**显式报错**。失败方式从静默出错变成硬报错。
- **代价**：① 模型先验是裸整数，需完全照抄；② 与按 Codex 格式训练的第三方 agent、以及 Codex 真实 trace 回放**互不兼容**；③ 每次 `get_app_state` 多几百 token。
- **必须收敛的文档矛盾**：`01-architecture.md` §2.4 说"格式必须逐字对齐"，而 `02-swift-helper.md` §2.3 说"模型看到的就是这个字符串不是裸 index"。两处自相矛盾。

同类：`<app_state>` 包裹标签 JS 面确证 Codex 没有、MCP 面不可证伪，判定**无害**，但应停止把它当 parity 证据
（`toolCalls.test.ts` 那条用例名断言的是我们自己的发明）。

---

## 8. 已验证无问题（别重复开单）

- 10 个工具名与顺序 **10/10 逐字一致**
- 变更回执 `Action completed. Call \`get_app_state\` to fetch the updated UI state.` **逐字一致**
- 拒绝文案模板 `Computer Use is not allowed to use the app '<app>' for safety reasons.` **逐字一致**
- `app` 在 9 个定向工具上**必填、无 frontmost 兜底** —— 与 Codex 一致
- `defersLockAcquire === "list_apps"` —— 与 Codex「9 个定向工具包 policy，只有 `list_apps` 不包」吻合
- `l`/`r`/`m` 与 `u`/`d`/`l`/`r` 别名**是 Codex 本来就有的**（`MouseButton.d.ts` / `Direction.d.ts` 穷尽联合类型）
- skyshot 树行语法：缩进/role/traits/字段序/focus 尾行/`_NS:` 过滤/frame 不入文本 —— 全部实现
- `Removed element IDs: ` 与 `with ~ and + representing…summarized by ID range.` —— 与 Codex **一字不差**
- 注入梯度保留合成事件兜底**正当**：Codex 四个二进制 `CGEventPost`/`CGWarp`/`IOHIDPostEvent` 全 0（唯一 CGEvent 符号是只读的 `_CGEventGetFlags`），
  但 Codex 自带功能开关 `computerUseAlwaysSimulateClick`（"Prefer simulating physical clicks over Accessibilty actions."）
  ⇒ OpenAI 自己也承认存在 AX 不够用的场景。且**坐标兜底是 CEF 类应用的唯一通路（判决二），不可删**，仿射变换已实装
- 命门判决**零违反**：无"找不到目标兜底 frontmost"（TS/Swift 双层 fail-closed）；`activate` 删除彻底
  （全仓唯一 `runtime.activate` 在 `ForegroundLease.swift:317` 的 `.restore` 分支，作用是**把用户原前台还回去**，方向相反）
- warm-up 轮询代码**地基已换**：理由改成"`enableEnhancedAX` 后 Chromium 异步挂树"，有终止条件、封顶 1.2s、每进程一次，成本有界
- `get_app_state` **会**后台拉起未运行 app（`activate: false`），与 Codex 一致 —— 那句 "must never launch anything" 是 `resolveTarget` 的注释
- `get_app_state` 前置强制**我们有**，在 Swift 侧（三种寻址模式各有 fail-closed 拒绝路径），与 Codex `noActiveSession: -10011` 形态对等

---

## 9. 残留风险（不在本次评审范围，但记一笔）

`Injection.swift:262-289` 的 frontmost 兜底只服务 legacy `key`/`hold_key`/`type`/`paste_clipboard`，
语义面（darwin）不可达，但**这四条命令仍挂在 daemon socket 上**。属安全面。
