# Computer Use 原生化设计方案（Swift Helper）

> 目标：把底层执行层从 `pyautogui`（HID 层模拟，独占鼠标）替换为原生 Swift helper（按 PID 定向注入 + Accessibility + ScreenCaptureKit），实现 **不抢占用户鼠标键盘** 与 **后台窗口操作/截图**，向 Codex Computer Use 的体验对齐。
>
> 本文是**技术方案/评审稿**，不含落地代码。决策点见末尾「八、待决策」。

相关文档：[Computer Use 架构深度解析](./computer-use.md) · [功能指南](../desktop/computer-use.md)

---

## 一、动机与问题

当前实现（见架构文档「五、Python Bridge」）用 `pyautogui` 执行鼠标/键盘：

```python
# runtime/mac_helper.py
pyautogui.moveTo(x, y)          # 移动系统唯一的真光标
pyautogui.click(x=x, y=y, ...)
pyautogui.write(text, ...)
```

`pyautogui` 在 macOS 底层调用 `CGEventPost(kCGHIDEventTap, event)`——注入到**硬件 HID 事件层**。后果：

1. **独占外设**：系统只有一个物理光标，注入即把它拖走，用户无法同时操作；
2. **全局生效**：事件落到"当前前台窗口/光标下的窗口"，无法定向到某个后台 App；
3. **必须前台可见**：要点的窗口必须在最前。

这与用户的核心诉求冲突：**一边自己工作，一边让 Agent 在另一个 App 上跑自动化（build / 点击 / 截图），且不需要把那个桌面亮在最前**。

---

## 二、Codex 机制拆解（逆向证据）

对 `Codex Computer Use.app` 做 `otool -L` / `nm -u` / `strings` / `codesign` 分析，得到以下事实（证据见附录 A）：

### 2.1 进程拓扑

```
Codex Computer Use.app
├─ MacOS/SkyComputerUseService            主服务（Swift，LSUIElement=true 无 Dock 后台代理）
└─ SharedSupport/
   ├─ SkyComputerUseClient.app            真正承载 MCP 的客户端（.mcp.json 指向它 + `mcp` 参数）
   ├─ CUALockScreenGuardian.app           锁屏守卫（检测物理输入→fail-closed 重锁）
   └─ Codex Computer Use Installer.app    安装授权插件
```

- entitlements：`com.apple.security.application-groups`（进程间共享）+ `com.apple.security.automation.apple-events`。
- 自动更新：`SUFeedURL` 指向 OpenAI 的 appcast（独立于 Codex 主体更新）。

### 2.2 三项关键能力 = 不抢鼠标的根因

| 能力 | 用到的 API（二进制实证） | 作用 |
|------|--------------------------|------|
| **按 PID 定向注入** | `CGEvent*` + IPC `ComputerUseIPCAppPerformActionRequest` + `targetPID` | 事件投给**目标 App 进程**，不经过全局 HID 光标 |
| **控件级操作** | `AXUIElementPerformAction` / `AXUIElementSetAttributeValue` / `AXUIElementCopyElementAtPosition` | 直接按按钮、设值，后台窗口也能操作；字符串提示 `Prefer simulating physical clicks over Accessibility actions.` 说明 CGEvent 优先、AX 兜底 |
| **虚拟光标** | `AccessibilitySupport.VirtualCursor`、`cursorPositionInScaledCoordinates`、`SkyLensView` + `Lens_frame_00~44.png` | 自己维护一个逻辑光标位置，并画一个**覆盖层"AI 光标(透镜)"**给用户看，而非借用系统真光标 |

### 2.3 截屏

`ScreenCaptureKit`（`SCStream` + `ComputerUseIPCAppStartCaptureRequest`，带捕获动画覆盖层）——可捕获**指定窗口的图层 surface**，窗口即使不在最前、被遮挡、在别的 Space 也能抓到。

### 2.4 共存 / 锁屏自治（高级，本方案不复刻）

- `ComputerUseUserInteractionMonitor` + `userInteractionDebounceDuration`：检测真人输入并退避。
- `LockScreenPhysicalInputMonitor` / `SystemLockScreenOverlayPresenter`：可在锁屏下 auto-unlock 全自动接管，一旦检测物理输入立即 fail-closed 重锁。**涉及密码与安全，风险高，v1 砍掉。**

### 2.5 结论

> Codex 不抢鼠标的本质 = **事件按 PID 定向投递 + AX 控件操作 + 自绘虚拟光标**，三者都绕开了"系统唯一物理光标"。我们用 `kCGHIDEventTap` 走的恰是相反方向。

---

## 三、关键认知校正：macOS 没有"免费的后台桌面"

必须写清楚，避免方向性误解：

- macOS 整机**只有一个 WindowServer / 一个 GUI 会话**，没有 Linux Xvfb 式的无头第二桌面。
- 所谓"后台/不亮桌面"的真实含义：
  - **截屏**靠 ScreenCaptureKit 抓窗口 surface → 窗口不必在最前；
  - **注入**靠按 PID / AX → 不抢真光标；
  - 你**能**在 App B 工作、让它驱动 App A。
- **真·完全隔离**（互不干扰的独立桌面）在 macOS 上只能靠：① 独立用户账户 + 快速用户切换；② macOS 虚拟机。
- Codex 的锁屏自治是"你离开 → 全自动；你回来碰一下 → 退避重锁"的折中，不是隔离桌面。

---

## 四、目标架构：只换最底一层

最大化复用——**上层全不动，只把 helper 从 Python 换成 Swift 二进制**。

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1-4  MCP 工具(24) · 9 层安全关卡 · 191 应用分类 · 权限 UI │  ← 完全复用，零改动
├─────────────────────────────────────────────────────────┤
│ Layer 5    pythonBridge.ts —— 进程调用边界                  │  ← 改几行：指向 Swift 二进制
├─────────────────────────────────────────────────────────┤
│ Layer 6    [旧] mac_helper.py (pyautogui, HID 层)          │
│            [新] cu-helper  (Swift: CGEventPostToPid+AX+SCK) │  ← 本方案唯一新增/重写
└─────────────────────────────────────────────────────────┘
```

### 4.1 可替换边界（已确认）

`src/utils/computerUse/pythonBridge.ts:159` 的调用形态：

```ts
execFile(pythonBinPath(), [helperPath, command, '--payload', JSON.stringify(payload)])
// 解析 stdout 的 { ok: boolean, result?: T, error?: { message } }
```

Swift 二进制只要遵守**完全相同的协议**即可热插拔：

```
cu-helper <command> --payload '<json>'
# stdout: {"ok":true,"result":...}  或  {"ok":false,"error":{"message":"..."}}
```

替换点：把 `pythonBinPath()` + `helperPath` 抽象成 `resolveHelperCommand()`，按配置/平台返回 `["python3", mac_helper.py]` 或 `[cu-helper]`。保留 Python 作为 fallback / 非 mac 平台。

### 4.2 命令协议（Swift 端需实现的全集）

沿用架构文档「命令映射表」，逐条给出新实现方式：

| 命令 | 旧（pyautogui/mss） | 新（Swift） |
|------|--------------------|-------------|
| `screenshot` / `zoom` | mss 全屏 | `SCScreenshotManager.captureImage`（显示器或窗口 filter） |
| `click`/`double`/`triple` | `pyautogui.click` (HID) | `CGEventPostToPid(pid)` 鼠标事件；可选 AX `kAXPressAction` 兜底 |
| `type` | `pyautogui.write` (HID) | `CGEventPostToPid` 键盘事件；文本框可走 AX `setValue` |
| `key` / `hold_key` | `pyautogui.hotkey` | `CGEventPostToPid` 带 flags |
| `drag` / `mouse_down` / `mouse_up` | `pyautogui.dragTo` | `CGEventPostToPid` mouseDown→moved→up 序列 |
| `scroll` | `pyautogui.scroll` | `CGEventCreateScrollWheelEvent` + `PostToPid` |
| `mouse_move` / `cursor_position` | `pyautogui.moveTo`/`position` | 仅更新**虚拟光标**逻辑坐标 + mouseMoved 事件（驱动 hover） |
| `frontmost_app` / `list_*` / `open_app` | NSWorkspace/Quartz | 同（`AppKit`/`CoreGraphics` 原生） |
| `read_clipboard`/`write_clipboard` | NSPasteboard | 同 |
| `check_permissions` | osascript+CGDisplayCapture | `CGPreflightScreenCaptureAccess` + `AXIsProcessTrustedWithOptions` |

> 关键差异只在 **鼠标/键盘注入** 和 **截屏** 两类；其余命令照搬原生等价实现即可。

---

## 五、关键技术点详解

### 5.1 事件注入：从 HID 层切到按 PID

核心就这一个 API 替换（伪代码）：

```swift
// 旧路径（pyautogui 等价）：注入到硬件层 → 抢真光标
CGEvent(...)?.post(tap: .cghidEventTap)

// 新路径：投给目标进程 → 不动真光标
let e = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                mouseCursorPosition: pt, mouseButton: .left)
e?.postToPid(targetPid)   // CGEventPostToPid(pid, event)
```

- `targetPid` 来自 `frontmost_app` / 已授权 App 的 `NSRunningApplication.processIdentifier`。
- 点击序列：`mouseMoved → leftMouseDown → leftMouseUp`，多击靠 `setIntegerValueField(.mouseEventClickState, n)`。
- 坐标仍走现有 `scaleCoord()`（架构文档「坐标系统」），无需改上层。

### 5.2 Accessibility 兜底

CGEventPostToPid 对后台 App **不是万能**（见 §6.2），故对"按钮/菜单项/文本框"提供 AX 路径：

```swift
let app = AXUIElementCreateApplication(targetPid)
// 命中坐标处控件
var elem: AXUIElement?
AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &elem)
AXUIElementPerformAction(elem, kAXPressAction as CFString)        // 点击
AXUIElementSetAttributeValue(elem, kAXValueAttribute as CFString, text) // 设值
```

策略：**CGEvent 优先（更像真实交互），失败/不可靠场景 AX 兜底**（与 Codex 一致）。

### 5.3 ScreenCaptureKit 后台窗口捕获

```swift
let content = try await SCShareableContent.current
let window = content.windows.first { $0.owningApplication?.bundleIdentifier == bundleId }
let filter = SCContentFilter(desktopIndependentWindow: window)   // 或 display
let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
```

- macOS 14+ 的 `SCScreenshotManager` 适合"每步一张"的单帧截图，无需常驻 stream。
- 输出仍编码为 JPEG/base64，尺寸经现有 `imageResize.ts` 处理，上层零改动。

### 5.4 虚拟光标覆盖层（可选但强烈建议）

不动真光标后，用户看不到 AI 在点哪 → 需自绘：

```swift
let win = NSWindow(...)
win.level = .screenSaver                 // 或 CGShieldingWindowLevel
win.ignoresMouseEvents = true            // 不拦截用户真实操作
win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
win.backgroundColor = .clear; win.isOpaque = false
// 内部画一个光标/透镜图标，随逻辑坐标移动（对应 Codex SkyLensView/Lens_frame_*）
```

### 5.5 人机共存监听（可选，v2）

```swift
NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .keyDown]) { _ in
  // 检测到真人输入 → 暂停注入 / debounce 让位
}
```

---

## 六、风险与权衡（决策关键）

### 6.1 签名 / TCC —— 隐形的最大成本

- Computer Use 需要两项 TCC：**屏幕录制** + **辅助功能（Accessibility）**。
- **未签名 / ad-hoc 签名的二进制，每次 rebuild 都会让已授予的 TCC 失效**，开发期反复重新授权，极其影响迭代。
- 要稳定授权 + 可分发，需要 Developer ID 签名（理想情况再公证）。这与本项目已知的 **Apple 付费签名墙** 是同一堵墙（见 memory：未签名 DMG 分发问题、Electron 迁移的签名前置）。
- 缓解：开发期固定一个稳定签名身份（哪怕自签 + 手动信任），把 helper 作为长期稳定的独立二进制，减少 rebuild 对主 App 授权的牵连。

### 6.2 各 App 可控性预期（务必管理预期）

| App 类型 | CGEventPostToPid | AX | 预期 |
|----------|------------------|----|----|
| 原生 AppKit（Notes/Finder/系统设置/多数三方原生） | 多数可用 | 好 | ✅ 可靠 |
| 后台**键盘**输入（非 key 窗口） | 最不稳 | 文本框走 setValue 较稳 | ⚠️ 需 AX 兜底 |
| 浏览器（Safari/Chrome/Arc…） | 不可靠 | 差 | ❌ 应走 Chrome MCP（现有 deniedApps 已降级只读） |
| Electron（VS Code/部分应用） | 不稳 | 不全 | ⚠️ 逐个验证 |
| 游戏 / Metal / IOKit HID | 几乎不响应 | 无 | ❌ 不支持 |

> Codex 之所以给 Notion/Spotify 等各写 `AppInstructions/*.md`、并保留锁屏全自动通道，正是因为"任意 App 都稳"做不到，要逐 App 调教。我们 v1 只承诺 **原生 AppKit App 的不抢鼠标控制**。

### 6.3 macOS 单会话限制

见 §三。"后台"≠ 隔离桌面；要真隔离须独立账户或 VM，超出本方案范围。

---

## 七、分阶段实施计划

| 里程碑 | 内容 | 验收 | 预估 |
|--------|------|------|------|
| **M0** | TS 侧抽象 `resolveHelperCommand()`，支持 Python/Swift 切换 + 配置开关 | 切到一个 echo Swift 二进制能跑通 JSON 协议 | 0.5 天 |
| **M1** | Swift：`screenshot`/`zoom`（SCK）+ 只读类命令（frontmost/list/clipboard/permissions） | 截图与 Python 版一致；权限检测正确 | 2–3 天 |
| **M2** | Swift：`click` 用 `CGEventPostToPid`，**验证真光标不动** | 在 Notes/计算器点击成功且光标不移动 | 2–3 天 |
| **M3** | `type`/`key`/`scroll`/`drag`/`mouse_down/up` | 输入/滚动/拖拽在原生 App 成立 | 2–3 天 |
| **M4** | AX 兜底（`kAXPressAction`/`setValue`/命中坐标） | CGEvent 失败的控件用 AX 成功 | 2–3 天 |
| **M5** | 虚拟光标覆盖层 | 用户能看到 AI 光标位置 | 1–2 天 |
| **M6（可选）** | 共存监听退避 | 真人输入时暂停 | 1–2 天 |
| **砍** | 锁屏自治 / Guardian / auto-unlock | —— | 不做 |

打包：Swift binary 随 `runtime/` 分发（类比 `mac_helper.py`），或作为 SwiftPM executable 在构建期产物。注意 §6.1 签名。

**总计：核心（M0–M5）约 2 周；M6 + 调教另算。**

---

## 八、对照方案：你"自测自己 App"其实有更轻的路

用户的原始诉求里有"**开发桌面 App → build → 自动测试 → 自动截图**"。对**自己开发的 App**，computer-use（视觉+盲点击）是错的重型工具：

- **build**：`cargo tauri build` / `xcodebuild` —— 纯 CLI，无需 computer use。
- **自动测试 + 截图**：本项目是 **Tauri**，正解是 **`tauri-driver` + WebdriverIO**（Tauri 官方 WebDriver）或对 WebView 直接 **Playwright**；原生壳可用 **XCUITest**。它们通过**自动化协议**驱动，**天然不碰光标、可真后台、可进 CI**，比模拟点击稳一个数量级。

> 判据：**computer-use 适合驱动"无 API 的第三方任意 App"；驱动"你自己的 App"用 WebDriver/Playwright 更优。** 两者可并存：自测走 WebDriver，通用控制走 Swift helper。

---

## 九、待决策

1. **范围**：v1 是否就锁定"原生 AppKit App 的不抢鼠标控制 + 后台窗口截图"，明确不承诺浏览器/Electron/游戏？
2. **签名**：开发期是否接受固定一个自签身份手动信任以稳住 TCC？分发是否仍走现有未签名脚本路径（helper 单独处理）？
3. **是否并行做对照方案**：要不要先用 tauri-driver/Playwright 把"自测自己 App"这条最高频需求快速跑通，Swift helper 作为中长期通用能力推进？
4. **虚拟光标 / 共存监听** 是否纳入 v1（建议虚拟光标纳入、共存监听放 v2）？

---

## 附录 A：逆向证据（可复现）

```bash
BIN="/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService"

otool -L "$BIN"        # → ScreenCaptureKit / ApplicationServices / CoreGraphics / AppKit / Carbon
nm -u "$BIN"           # → _AXUIElementPerformAction / _AXUIElementSetAttributeValue / _AXUIElementCopyElementAtPosition ...
strings -a "$BIN"      # → VirtualCursor / cursorPositionInScaledCoordinates / SkyLensView
                       #   ComputerUseIPCAppPerformActionRequest / targetPID
                       #   "Prefer simulating physical clicks over Accessibilty actions."
                       #   LockScreenPhysicalInputMonitor / CUALockScreenGuardian
codesign -d --entitlements - "$BIN"   # → application-groups / automation.apple-events
```

关键字符串原样：
- `Enable the virtual cursor in Computer Use.`
- `Prefer simulating physical clicks over Accessibilty actions.`（原文拼写）
- `Detected physical input during lock-screen Computer Use auto-unlock; relocking and suppressing auto-unlock until manual unlock.`

## 附录 B：我们当前实现锚点

- 调用边界：`src/utils/computerUse/pythonBridge.ts:159`（`callPythonHelper`）
- 执行器：`src/utils/computerUse/executor.ts`
- Python helper：`runtime/mac_helper.py`（`click()` 在 :585）
- 上层（复用不动）：`src/vendor/computer-use-mcp/`（tools.ts / toolCalls.ts / deniedApps.ts …）
