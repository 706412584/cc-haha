# CEF/Electron 注入：为什么点击会静默失效

## 症状

对网易云音乐（CEF116）之类的 Chromium 应用，每一次 `click` / `type_text` 都返回
`Action completed.`，而界面**毫无变化**。模型拿到截图看不出所以然，只能反复重试，
最后幻觉出一个"已完成"。用户连续两轮拿到的都是不能用的东西。

受影响面远不止一个音乐播放器：VS Code、Slack、Discord、Notion——**所有 Electron 应用**。

## 根因

`CGEvent.postToPid` 投出去的裸事件，`windowNumber` 是 **0**。

- 原生 AppKit 应用不受影响：它会拿事件坐标对自己的窗口重新做命中测试。
- **Chromium/CEF 按事件声明的窗口做路由**。窗口号为 0 的事件无处可投，直接丢弃。

丢弃是静默的——`postToPid` 没有返回值，所以我们无从知道事件没落地，照样回执成功。

## 修复

投递前把窗口身份焙进事件（`WindowTargetedEvent.swift`）：

```swift
// 1. CGEvent 没有任何公开 API 能设置窗口号；唯一途径是绕道 AppKit
let ns = NSEvent.mouseEvent(
    with: nsType,
    location: 全局Quartz点,      // 屏幕坐标，不是窗口局部
    modifierFlags: [],           // 修饰键走 CGEventSetFlags，不在这里
    timestamp: 0,                // 真时间戳在 post 前才盖
    windowNumber: 目标窗口ID,     // ← 路由的钥匙
    context: nil,
    eventNumber: 单调递增,        // 重复会让连击被折叠成单击
    clickCount: n,
    pressure: 1.0
)
let cg = ns?.cgEvent

// 2. 窗口命中字段
cg.setIntegerValueField(CGEventField(rawValue: 91)!, value: 窗口ID)  // WindowUnderMousePointer
cg.setIntegerValueField(CGEventField(rawValue: 92)!, value: 窗口ID)  // ...ThatCanHandleThisEvent

// 3. 窗口内坐标（私有 SPI，dlsym 解析）
CGEventSetWindowLocation(cg, 全局点 − 窗口原点)   // 左上原点，不翻转

// 4. 送出
cg.timestamp = DispatchTime.now().uptimeNanoseconds
cg.postToPid(pid)
```

投递用的仍是**公开的 `CGEventPostToPid`**，和参考实现同一个 API。

### 后台目标：还要切前台并等沉降

窗口身份齐了，目标在后台仍然打不进去。需要 `SLPSSetFrontProcessWithOptions(&psn, winID, 0x2)`。

两个必须写下来的事实：

1. **它是真正的前台切换**，不是"只让窗口变 key"。用 System Events 直读
   `frontmostApplication` 实测：调用前 Finder、调用后目标 App。
2. **切换后的首击会被当作窗口的激活点击吞掉**。等 250ms → 全部失败；等 **800ms** →
   全部成功。这一个数字就是"后台操控不可能"与"它能用"之间的全部差距，
   落地为 `Injection.focusSettleMs`。

### 键盘完全不需要这一套

裸 `postToPid` 就通，**目标完全在后台也通**：不动指针、不切前台、不需要窗口身份。
所以最终形态是：

| 通道 | 后台可用 | 代价 |
|---|---|---|
| 键盘输入 | ✅ | 零 |
| 鼠标点击 | ✅ | 目标被带到前台 + 800ms 沉降 |

## 三次误判，与它们的教训

这个根因花了三轮才找对。记录弯路，因为每一条都会有人再走一遍。

**1. 「Codex 不合成事件、纯走 Accessibility」**

依据是 `nm -u` 显示它的服务只导入 `_CGEventGetFlags`，没有任何事件投递 API。
结论错得离谱——它有一层自研符号混淆：遍历已加载镜像 → 手解 `__LINKEDIT` 的
dyld export trie → **SipHash-2-4**(message = 符号名 ‖ 每 call site 一条 126 字符
salt) → dlsym。**所以导入表、`strings`、`nm` 全都看不见它真正调用的东西。**

> 教训：对做过反分析的二进制，导入表的"没有"不是证据。

**2. 「`subtype = 3` 是 Chromium 必需的」**

我在代码注释里写了"不设就被当作畸形事件丢弃"。这句话**没有任何实证支撑**，是从
参考实现推的。做单变量 A/B 后：去掉它照样工作。字段保留（无害、与参考一致），
但注释已改成"未独立验证、不是修复所在"。

> 教训：注释里的断言会被后人当作已验证的事实。没测过就写"未验证"。

**3. 「后台点击不通」**

测试本身是坏的：我以为 CPS 调用只给 key focus，实际它切了前台，所以那个"后台
失败"根本不是在测后台。真因是首击被吞，多等 550ms 即可。

> 教训：一个"失败"结论的前提条件必须独立验证，否则会把可修的东西记成产品边界。

## 实验纪律

- **只认截图前后对比，不认 API 返回值。** "返回成功但什么都没发生"正是这个 bug
  的形状，用返回值判断等于用 bug 验证 bug。
- **同一个 App 上同时只允许一个实验者。** 多 agent 并行注入会造出假阳性——本次
  就有人把别人打进搜索框的字当成了自己的成功。用唯一标记串隔离，并跑几次空操作
  量出误报率（本次实测约 1/6）。
- 串扰只造假阳性、不造假阴性，所以**阴性结论可以跨污染窗口采信**。

## 会静默退化的点（守门测试盯着）

| 点 | 退化后的症状 |
|---|---|
| `windowNumber` 扛不过 NSEvent→CGEvent 桥接 | 回到静默丢弃 |
| `CGEventSetWindowLocation` 解析不到 | 同上 |
| `SLPSSetFrontProcessWithOptions` 解析不到 | 后台点击变 no-op |
| `focusSettleMs` 被人调小 | 后台首击被吞 |
| `makeMouse` 调用点漏传 `targetPid` | 新路径完全走不到（犯过一次） |

真机步骤见 `computer-use-native-manual-qa.md` §2.5。
