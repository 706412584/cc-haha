<!-- LOCAL build spec. Distilled from 3 subagents deep-reading open-source Codex CU
     reverse-implementations (iFurySt/open-codex-computer-use [no license → reference
     only], OpenCodexLabs/open-codex-computer-use [MIT], vtomnet/codex-cua-tea [docs +
     OpenAI's verbatim AppInstructions → reference only]). 2026-06-09.
     IP rule: implement our OWN code to this spec; do NOT copy their Swift verbatim. -->

# Computer Use — Codex 实现蓝图(对照 3 个开源逆向实现)

3 个开源逆向实现 **一致印证了我们的方向**(AX 树感知 + AX 优先注入 + index 一等公民 + Electron 强开 AX),并给出了精确格式 + 算法。我刚写的 v1(AXTree.swift / AXAction.swift)**方向对、但有具体缺口**:axText 格式不对、遍历不全(Electron 会变噪声)、注入不安全。本文是把 v1 改对的权威规格。

参考源(只读参考,不抄码):
- `/tmp/iFurySt-cu/.../OpenComputerUseKit/AccessibilitySnapshot.swift`(渲染器=格式权威)、`ComputerUseService.swift`(注入梯度)、`KeyMapping.swift`、`ToolDefinitions.swift`;`docs/references/codex-computer-use-reverse-engineering/{baseline-architecture,state-rendering-1.0.770,tool-call-samples-2026-04-17}.md`(Codex 真实输出样本)。
- `/tmp/opencodexlabs-cu/Sources/ClaudexComputerUseCore/{AppState,UIElementService,WindowCapture,CodexCompat,AppGuidance}.swift` + `.../ClaudexComputerUseMCP/main.swift`(MCP 框装 + 变更后自动重拍)。
- `/tmp/codex-cua-tea/{SkyComputerUseService.md, AppInstructions/*.md}`。

---

## 1. 【最高优先】skyshot/get_app_state 文本格式(v1 render 必须重写)

Codex 真实格式(iFurySt 抓的样本,高置信):
```
App=com.apple.finder (pid 1106)
Window: "open-codex-computer-use", App: Finder.
0 standard window open-codex-computer-use, ID: FinderWindow, Secondary Actions: Raise
	1 split group
		2 scroll area
			3 outline sidebar
				4 row (selectable, expanded) Value: Favorites, Secondary Actions: Collapse

The focused UI element is 2 outline.
```
规则(每条都是我 v1 的偏差):
- **头两行**:`App=<bundleId 否则 name> (pid N)` + `Window: "<title 空则 appName>", App: <appName>.`(带句点)。**删掉**我的 `Elements: N` 行和空行。
- **index 无方括号**:`0 standard window`,不是 `[0] AXWindow`。格式 `"\(index) \(roleText)"`。
- **role 用人性化 `kAXRoleDescription`**(`standard window`/`split group`/`scroll area`/`outline`/`row`/`button`/`radio button`/`pop up button`/`text`…),**不是**原始 `AXRole`。特例:`AXRow`→`row`、`AXGroup`→`container`、`AXLink`→`link`、`AXWebArea`→其 roleDescription、menu-bar-item→`""`、static text→`text`。**这是最大单点偏差。**
- **缩进 = 每层一个 `\t`**,根窗口在 depth 0(零缩进)。我用的两空格要换成 `\t`。
- **traits 括号逗号列表**,紧跟 role:`(selectable, expanded)`、`(selected)`、`(settable, string)`、`(settable, float)`、`(disabled)`。词表:selected/expanded/disabled/settable + 值类型(string/float/boolean,仅当 kAXValue settable 时附加)。**删掉我的独立 `(focused)`**。
- **字段顺序**(role/traits/title 之后):`title`(裸,不加引号)→ ` Description: <kAXDescription>` → ` Help: <kAXHelp>`(我没读,要加)→ `, URL: <kAXURL>`(WebArea)→ ` ID: <kAXIdentifier>`(**`_NS:` 开头的要滤掉**)→ value(通常 ` Value: <v>`,但 static text/scroll bar/value indicator/text area/search field 用裸 ` <v>`)→ ` Placeholder: <v>`(我没读)→ ` Secondary Actions: <pretty,逗号>`。多个段之间用 `, ` 连。
- **不在文本里打 frame**(`{x,y wxh}` 删掉)——frame 只内部存给注入用,窗口相关坐标。
- **Secondary Actions 用 pretty 名 + 过滤**:去 `AX` 前缀 + 拆驼峰,`AXRaise`→`Raise`、`AXScrollUpByPage`→`Scroll Up`;**denylist 隐藏**:AXPress/AXShowDefaultUI/AXShowAlternateUI/AXShowMenu/AXConfirm/AXScrollToVisible(菜单再加 AXCancel/AXPick)。原始 action 列表内部保留给注入用。
- **value 数值/布尔**:checkbox/radio/tab 的 0/1 渲染成 `on`/`off`;slider/scrollbar 渲染原始 float。
- **focus 作为尾行**(不是每元素):树后空行 + `The focused UI element is <该节点的 index role (traits) title>.`;若有选中文本则 `Selected text: [<text>]`。focus 元素从 `kAXFocusedUIElement` 读。
- **sanitize**:换行→字面 `\n`,trim,**截断 160 字符 + `...`**(我现在 200 + `…`,改)。

> 实现策略:**自己实现** TreeRenderer(对照 iFurySt:595-1788 的字段/变换),不抄文件。手按上面列表写会漂,务必拿 `tool-call-samples-2026-04-17.md` 的真实样本做断言测试。

---

## 2. 遍历(v1 walk 缺口大,Electron 会变噪声)

- **子节点不止 kAXChildren**:并 `kAXChildren + kAXRows + AXContents + AXVisibleChildren`,按角色选主源(outline/list/table/AXBrowser 用 AXRows),CFEqual 去重,跳过菜单栏下的 Apple 菜单。**否则 Finder/系统设置/活动监视器的行全丢。**
- **环路守卫**:传 ancestors 集合,CFEqual 命中祖先则跳过(Electron 树有环,否则重复子树)。
- **【关键】泛容器消除 + 扁平化**:剪掉无描述的 AXGroup/AXUnknown 包装(同深递归进子)、单子无意义组折叠、纯文本兄弟合并成一个 ` text …`、链接渲染成 Markdown 的文本加 URL 形式并吞子。**没有这步,Electron 的 AXWebArea 是几千个空 wrapper,在到达有用控件前就撑爆 cap——这正是"Electron 看起来读不到树"的真因。**
- **菜单栏第二趟**:走完窗口后 `walk(copyElement(app, kAXMenuBar))` 追加(否则不能按 index 点菜单)。
- **行可见性窗口化**:outline/list 只 emit 可见行(与父框相交),cap 20,容器加 ` (showing 0-N of M items)` 摘要。
- **window-relative frame**:`localFrame = elementFrame - windowBounds.origin`,内部存。
- **caps**:深度降到 ~16-20(我现在 80 危险),emitted ~1200-1500;但 cap 只有在加了消除后才行为正确。
- **窗口解析更稳**:focused→main→first 之上加 not-minimized + kAXWindowRole 校验 + 隐藏 Electron 窗的 unhide/raise/un-minimize 恢复。

---

## 3. index 的可重解析定位(opencodexlabs 的最大稳健性优势)

每个元素除 flat `index` 外,存 `(windowIndex, path)`——从窗口根到该节点的子索引链。动作时 `resolveElement` **从 app 元素现场重走**:`windows[windowIndex]` → 逐级 `children[path[i]]`。这样 index 在一次"新 AX 查询"后仍有效(只要窗口拓扑没变),不依赖缓存的 AXUIElement 指针存活。menu item 用 directRef。
> 改 AXTree.Element 加 `windowIndex/path`,walk 累积 childPath;AXAction 先 `cachedElement(index)` 快路,失败再 `resolve(index)` 重走。

---

## 4. 注入梯度(AXAction v1 太薄 + 有危险)

- **click 不是单 AXPress**,顺序梯度:① 原生 list 行→对父 AXList 设 `AXSelectedChildren`(**选中,不是 press**——Finder 侧栏/活动监视器/系统设置的行这样"点");② AXPress→AXConfirm→AXOpen(**我的 press() 选"第一个 action"是危险的——可能把 AXShowMenu 当点击;限制到 {AXPress,AXConfirm,AXOpen}**);③ 向下 3 层找暴露 Press/Confirm/Open/ShowMenu 的后代;④ 元素中心 AX hit-test;⑤ 仅 window-role 元素的 activation-only(AXRaise/kAXMain/kAXFocused);⑥ 才回退合成 `CGEvent.postToPid`。**右键=AXShowMenu;clickCount>1=重复 N 次。**
- **set_value**:先 `AXUIElementIsAttributeSettable(kAXValue)` 门控,**不强行 focus**,返回 before/after 值;不可设则报 `"Cannot set a value for an element that is not settable"`。(改我 v1 的强 focus + 盲写。)
- **type_text(新增)**:先试把 focused 元素的 kAXValue 设成 当前值+text(**追加**);失败且 focused 是 text field/area 才回退 Unicode 键盘(keyboardSetUnicodeString,≤64 UTF16 分块)。
- **press_key(新增)**:实现 xdotool 词表(`super+c`/`Return`/`Tab`/`KP_0`/`Prior`/`Next`/`F1-12`),super/cmd/command/meta→Command,postToPid 带修饰键 down/up 括号。
- **scroll(新增)**:元素域,优先 `AXScroll{Up,Down,Left,Right}ByPage` 重复 floor(pages) 次,否则元素中心 postToPid 滚轮(12 行/页)。
- **perform_secondary_action**:**模型看到的是 pretty 名**(Raise/Scroll Up),要 pretty→raw 翻译再 AXUIElementPerformAction(我 v1 收原始名,匹配不上=bug)。无效报 `"<action> is not a valid secondary action for <index>"`。
- **drag**:坐标-only,postToPid down→10 段 dragged→up。
- **所有合成事件用 `CGEvent.postToPid(pid)` + source `.combinedSessionState`,绝不用 `.cghidEventTap`/`.hidSystemState`**——这才是"不抢真鼠标"。

---

## 5. 截图(给 get_app_state 用)

- 锁**目标 App 的单个关键窗口**(rank 选:on-screen+1M/active+2M/else area),`SCContentFilter(desktopIndependentWindow:)`,**scale 0.5**,showsCursor=false。坐标 = 截图像素空间(左上原点),server 端做 scale/offset→全局仿射。
- **SCK 卡死兜底**:detached Task + `DispatchSemaphore.wait(2.5s)`,超时取消→回退 `/usr/sbin/screencapture -l <windowID> -x -o`(3s + terminate→SIGKILL 升级)。
- **get_app_state 的截图包 `try?`**——截图失败也要返回 AX 文本。(单 main-actor daemon 里 SCK 卡死会 wedge 整个 run loop。)

---

## 6. staleness(3 守卫,无 hash)+ 变更后自动重拍

- ① 该 pid 没拍过 → 文本 `"The user changed '<app>'. Re-query the latest state with get_app_state before sending more actions."`;② index 越界 → `isError` `"Element index N not found in snapshot (has M elements)."`;③ 动作后 NSRunningApplication(pid)==nil → 作废 session。
- **每个变更工具的返回 = 重跑 get_app_state(树+窗口截图)**(codexMutationResponse,main.swift:1517-1580)——模型几乎不用手动在动作间 get_app_state,index 几乎永远只老一步。这是让粗粒度 staleness 可用 + agent 循环高效的关键行为。
- daemon 持有 **per-pid AppStateSession**(快照+元素 refs+paths),跨 socket 请求存活。

---

## 7. MCP 工具面(逐字 Codex 名)+ get_app_state 框装

工具(9 个原生名):`list_apps, get_app_state, click, perform_secondary_action, set_value, scroll, drag, press_key, type_text`(`select_text` 不是独立原生工具)。
- `click` 接 `element_index?`(**string 或 int**,Codex 发 string)**或** `x,y`;`click_count?`、`mouse_button?`(1=left/2=middle/3=right/4=back/5=forward)。
- **get_app_state 响应在 MCP server 框装**(不在 Swift):content = `[{type:text, text:envelope}, {type:image, data:base64 PNG, mimeType:image/png}]`(截图成功才附图)。envelope:
  ```
  Computer Use state (CUA App Version: <v>)
  <app_specific_instructions>…</app_specific_instructions>   // 该 app 首次 session 才投,非空才投
  <app_state>
  App=… (pid …)
  Window: …
  \t0 …
  </app_state>
  The focused UI element is …
  ```
  另带 structuredContent(完整类型化结果)给非-Codex harness。
- 动作回执:`Action completed. Call get_app_state to fetch the updated UI state.`
- 遥测:`time_to_first_get_app_state`/`time_from_first_get_app_state_to_first_write`/`time_to_first_write`。

---

## 8. 每-App 指令 + frameReliability(高价值低成本)

- `<app_specific_instructions>` = 按 bundleId 加载 `AppInstructions/<App>.md` 注入。Codex 自带 Clock/Spotify/Notion/Numbers/AppleMusic 等(OpenAI 版权内容,**只参考格式、自己写**)。格式:H2 标题 + H3 主题 + `<Key>` 尖括号键名 + 友好元素 id + 鼓励并行调用。典型内容=app 特定怪癖(选择模型、异步状态、占位符文本、哪些按钮、别做什么)。
- **frameReliability 分类器**(bundleId→browser/finder/jetbrains/electron/native→high/medium/low):low(Electron/微信/飞书)→ 不信 frame 坐标、优先 pasteboard 输入 + delivery:direct、虚拟光标锚窗口中心。兼容矩阵:原生 AppKit=可靠,Electron=需变通,自绘(微信~13 元素)=尽力。

---

## 9. 外围(真全复刻,后置)

- **per-app 授权 elicitation**(session vs persistent,prompt-injection 警告,JSON 存),turn-scoped session 按 thread id,turn 末作废。
- 浏览器走独立 Browsing MCP(对齐我们既有 claude-in-chrome),不在原生 CU 里。
- Skysight 被动记忆 / Record&Replay / LockScreenGuardian:独立子系统,阶段2/后置。

---

## 我 v1 要改的清单(按优先级)
1. **AXTree.render 重写成 §1 格式**(最高杠杆)。
2. **§2 遍历**:rows/contents/visibleChildren + 环路守卫 + 泛容器消除 + 菜单栏 + 行窗口化(Electron 能用的前提)。
3. **§3 (windowIndex,path) 定位** + §6 staleness/session。
4. **§4 注入梯度**:限制 press 到 {Press,Confirm,Open}、list 选中、set_value 门控、perform pretty→raw、新增 type_text/press_key/scroll。
5. **§5 窗口锁定截图 + 卡死兜底**(P1-C)。
6. **§7 工具面 + envelope 框装**(P1-D)。
7. **§8 per-app 指令 + frameReliability**、**§9 外围**(后置)。
