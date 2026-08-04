---
name: ui-layout-api
description: WasiCore 流式布局 UI API 参考。尺寸、间距、对齐、Flexbox、响应式布局的链式 API。当创建 UI 界面、设置布局、使用 Panel/Label/Button 等控件时使用。
when_to_use: 当查询 GameUI API，或在已有页面结构中实现 Panel/Label/Button、Flow/Flex/Grid、尺寸、间距、局部对齐与定位时使用。创建完整页面、重做信息架构或视觉精修时先使用 ui-visual-design。
allowed-tools: Bash, Read, Glob, Grep, Edit, Write
---

# 流式布局 UI API 参考

所有扩展方法返回控件本身，支持链式调用。

核心类：`LayoutExtensions`（布局）、`BuilderExtensions`（控件属性）、`UI`（静态构建器）。

> **对齐默认值警告**：所有控件的 `HorizontalContentAlignment` 和 `VerticalContentAlignment` 默认为 **Center**。
> 当子控件未显式设置 `HorizontalAlignment` / `VerticalAlignment` 时，会继承父控件的 Center 对齐，
> 导致 Margin 从中心偏移而非从左上角偏移，产生文字偏右下的视觉问题。
> **多个子控件更危险**：若容器内有多个子控件都未设对齐，它们全部被居中到同一区域后完全重叠。
>
> **必须遵守**：
> - 用 Margin 定位子控件时，务必同时设置符合设计意图的水平和垂直对齐。只有以左上角为原点时才使用
>   `HorizontalAlignment = Left`、`VerticalAlignment = Top`（或 `.AlignLeft().AlignTop()`）；贴右、贴底或居中元素使用对应的 Right/Bottom/Center 对齐。
> - 容器内有 2 个以上普通内容子控件时，优先使用 `FlowOrientation`（`.FlowVertical()` / `.FlowHorizontal()`）自动排列，
>   避免手动计算 Margin 导致重叠；Overlay、Badge、地图 Marker 等明确叠层除外。
>
> **推荐优先使用流式扩展方法**（`.AlignLeft()`, `.Size()`, `.Margin()` 等），而非对象初始化器直接赋值属性。
> 流式风格鼓励显式设定每个布局属性，漏写对齐时更容易察觉"缺了什么"，且能避免 Margin 定位陷阱。
> 对象初始化器在样例代码中常见，但容易遗漏对齐设置。

## 运行时排版验证

当编辑器 MCP 提供 `runtime_call_tool`，并且用户已经启动普通调试、调试不编译或纯客户端调试时，AI 助手应优先使用 Runtime MCP 获取实时画面和 UI 控件数据，再决定如何调整布局。

推荐闭环：

1. 调用 `debug.capture_screenshot` 保存当前客户端截图，确认真实视觉状态。一般布局检查可传 `maxWidth: 1920, maxHeight: 1080` 或 `maxWidth: 1280, maxHeight: 720` 限制图片尺寸；需要辨认细小文字或像素细节时保留原始分辨率。
2. 调用 `ui.snapshot` 获取 GameUI 控件树、文本、可见性和 `rect_px`。
3. 用 `ui.find` 查找目标按钮、标签、面板或输入框。
4. 用 `ui.get_rect` 获取目标控件的屏幕像素坐标和尺寸。
5. 根据截图与坐标调整 `.Size()`、`.Margin()`、`.Padding()`、`.Align*()`、`.Flow*()`、`.WidthGrow()` 等布局代码。
6. 重新启动调试或刷新客户端后再次截图和查询，确认排版已符合预期。

不要只靠猜测坐标或用户口述来修 UI。若截图和 `ui.snapshot` 不一致，优先相信截图中的最终视觉结果，再用控件树定位可能的布局来源。Canvas 直接绘制的内容不一定出现在 `ui.snapshot` 中，此时用截图判断视觉问题，用 UI inspector 检查外围 GameUI 容器。

### 运行时几何审计

布局验证不能停在“节点存在”。基于 `ui.snapshot.rect_px` 或 `ui.get_rect` 至少检查：

1. **父子越界**：将可见子节点矩形与父节点可见矩形求差。普通内容越界是错误；背景、粒子、地图 Marker、阴影和明确 `NoClip()` 的装饰可列入具名白名单。
2. **兄弟重叠**：同父、可见且非零面积的兄弟节点求交集。文字盖按钮、按钮互盖、透明交互层盖住其他入口属于错误；Modal、Badge、选中框、Overlay、Toast 等有明确叠层意图的节点例外。
3. **裁剪一致性**：父节点使用 `ClipContent()` 时，截图中不得出现越界残留；使用 `NoClip()` 时也不能让装饰遮住关键文字或交互。
4. **Safe Zone**：标题、返回、资源、主 CTA 和底部导航必须位于安全内容区域；只有背景与非交互装饰可以延伸到 Safe Zone 外。
5. **触控矩形**：可见按钮区域与实际交互 rect 应一致，运行时建议至少约 `44×44px`，相邻按钮保留防误触间距。透明点击层不得超过可见控件边界或遮挡其他控件。
6. **文本边界**：长文本、本地化文本和大数字不得侵入图标、按钮或父容器外；需要换行、截断或 ScrollView 时必须显式配置并截图验证。

几何检查只发现确定性的结构错误，不能替代截图中的视觉层级、构图和资源语义判断。自动审计必须输出节点 id、父节点 id、实际 rect、越界量或交集矩形；不得只返回“布局异常”。

### 缩放验证矩阵

响应式布局至少覆盖以下 viewport，不只测试一个等比窗口：

- 与设计分辨率等比的基准 viewport；
- 较小的等比 viewport；
- 比设计比例更宽的 viewport；
- 比设计比例更窄的 viewport；
- 项目实际目标设备 viewport。

每个 viewport 记录 `designWidth/designHeight`、`ScaleMode`、source 尺寸、理论 scale、root `rect_px`、关键控件 `rect_px`、Safe Zone、预期 letterbox/crop 和截图。理论 scale：

```text
Contain     = min(sourceWidth / designWidth, sourceHeight / designHeight)
Cover       = max(sourceWidth / designWidth, sourceHeight / designHeight)
MatchWidth  = sourceWidth / designWidth
MatchHeight = sourceHeight / designHeight
```

允许由 `ScaleMode` 产生的预期留白或裁切；不允许通过任意扩大 root、整体拉伸图片或添加补偿 Margin 掩盖问题。字体、图标、触控目标应随 scale 保持相对层级，并在最小目标 viewport 仍可读可点。

## 尺寸

```csharp
control.Size(200, 100)       // 宽高
control.Size(150)            // 正方形
control.Width(200)
control.Height(100)
control.AutoWidth()          // 自动宽度
control.AutoHeight()         // 自动高度
control.AutoSize()           // 自动宽高
```

## 位置

```csharp
control.Position(100, 50)    // 绝对定位
control.Offset(10, 20)       // 相对偏移
```

## 对齐

```csharp
control.AlignLeft() / .AlignRight() / .AlignTop() / .AlignMiddle() / .AlignBottom()
control.Center()
control.StretchHorizontal() / .StretchVertical() / .Stretch()
```

## 边距

```csharp
control.Margin(10)           // 四边均匀
control.Margin(20, 10)       // 水平, 垂直
control.Margin(10, 5, 10, 5) // 左, 上, 右, 下
control.Padding(15)          // 同上模式
```

## 流式布局

```csharp
control.FlowHorizontal() / .FlowVertical()
control.ContentAlignHorizontal(HorizontalContentAlignment.Left)
control.ContentAlignVertical(VerticalContentAlignment.Top)
control.ContentCenter()

// Flexbox 风格（基于 FlowOrientation 智能选择轴向）
control.JustifySpaceBetween()    // 主轴 space-between
control.JustifySpaceAround()     // 主轴 space-around
control.AlignSpaceBetween()      // 交叉轴 space-between
control.AlignSpaceAround()       // 交叉轴 space-around
control.JustifyStretch()         // 主轴拉伸
control.AlignStretch()           // 交叉轴拉伸

// 组合
control.HorizontalSpread()       // = FlowHorizontal + JustifySpaceBetween
control.VerticalSpread()         // = FlowVertical + JustifySpaceBetween

// Flex 增长/收缩
control.WidthGrow(1.0f) / .HeightGrow(0.5f) / .GrowRatio(1, 2)
control.WidthShrink(0.5f) / .HeightShrink(0.3f) / .ShrinkRatio(0.5, 0.5)
control.FlexBasis(100, 50) / .FlexBasisWidth(100) / .FlexBasisHeight(50)
```

## 快速堆叠

```csharp
control.VStack(spacing: 10)  // 垂直堆叠
control.HStack(spacing: 15)  // 水平堆叠
```

## 控件属性

```csharp
control.Visible(true) / .Hidden()
control.Enabled(false) / .Disabled()
control.DataContext(data)
control.Background(Color.Blue) / .Background(brush)
control.Opacity(0.8f)
```

## 文本控件

```csharp
label.Text("Hello").TextColor(Color.Red).FontSize(16).Bold().Italic()
button.Text("按钮").TextColor(Color.White).FontSize(16).Bold()
```

## 容器

```csharp
container.AddChild(child).AddChildren(child1, child2, child3)
```

## 事件

```csharp
button.OnClick((sender, e) => { /* 逻辑 */ })
button.OnClick(() => { /* 简化 */ })
```

## 外观样式

```csharp
control.CornerRadius(8)
control.ZIndex(10)
control.Opacity(0.8f)
control.ClipContent()        // 裁剪超出内容
control.NoClip()             // 允许内容溢出
control.MinWidth(100).MaxWidth(300).MinHeight(50).MaxHeight(200)
```

## 响应式设计

```csharp
control.ResponsiveWidth(100, 300)           // min, max
control.ResponsiveHeight(50, 150)
control.ResponsiveSize(100, 300, 50, 150)   // wMin, wMax, hMin, hMax
label.ResponsiveFontSize(12, 24, 1.2f)     // min, max, multiplier
control.ResponsiveSpacing(8, 24)
control.ResponsivePadding(12, 32)
control.ResponsiveContainer(ResponsiveContainerSize.Standard)
button.ResponsiveButton(ResponsiveButtonSize.Medium)
container.ResponsiveOrientation(Orientation.Horizontal, Orientation.Vertical)
control.ResponsiveVisibility(ResponsiveVisibility.MediumAndUp)
```

## 高级布局

```csharp
// 网格
var grid = TrueGrid(3, rowSpacing: 8, columnSpacing: 12, child1, child2, ...);
var autoGrid = SimpleGrid(10, item1, item2, ...);

// 语义化组件
control.Card(padding: 20, radius: 8, elevation: 2)
button.Button(height: 44, padding: 16, radius: 4)
input.Input(height: 40, width: 280, padding: 12)
item.ListItem(height: 48, padding: 16)

// 文本样式
label.Title(fontSize: 24, margin: 16)
label.Subtitle(fontSize: 18, margin: 12)
label.Body(fontSize: 16, margin: 8)
label.Caption(fontSize: 12, margin: 4)
```

## 静态构建器

```csharp
var panel = UI.Panel();
var button = UI.Button();
var label = UI.Label("Hello");

var vstack = UI.VStack(spacing: 10,
    UI.Label("标题"),
    UI.Button(),
    UI.Label("底部")
);

var hstack = UI.HStack(spacing: 15, UI.Button(), UI.Label("说明"));
var centered = CenterContainer(UI.Label("居中文本"));

// 预定义样式
UI.Title("标题", fontSize: 24)
UI.Subtitle("副标题", fontSize: 18)
UI.PrimaryButton("主要按钮")
UI.SecondaryButton("次要按钮")
UI.Button("按钮")
```

## 内置颜色

```csharp
UI.Colors.Primary / .Secondary / .Success / .Warning / .Error
UI.Colors.Background / .Surface
UI.Colors.OnPrimary / .OnSurface / .OnBackground
```

## 共享资源与 NineSlice 治理

多页面项目先复用已有 `UiTheme`、`UiAssets`、`UiChrome` 或等价共享入口。若项目没有共享入口，且同一资源在至少两个页面复用，建立最小集中定义，至少包含：

- `PrimaryButton`、`SecondaryButton`、`DangerButton`；
- 主面板、轻量条目框、弹窗框；
- 资源路径、正常/按下/禁用状态资源；
- 默认尺寸、Padding 和 NineSlice 的 left/top/right/bottom。

页面代码不得散落重复的资源路径和切片数字。同页面、同层级、同语义按钮必须使用同一套资源与尺寸；状态变化通过已定义的状态资源、颜色、透明度和文字表达，不为每个按钮临时换皮肤。

NineSlice 使用前同时验证：

```text
sliceLeft + sliceRight < 原图宽度
sliceTop + sliceBottom < 原图高度
sliceLeft + sliceRight < 控件运行时宽度
sliceTop + sliceBottom < 控件运行时高度
```

还必须确认图片可真实解码、格式与扩展名一致、Alpha 正常，并在真实客户端检查接近原图尺寸、横向拉伸、纵向拉伸、双向拉伸四种形态。API 存在、文件存在或代码编译通过都不能证明 NineSlice 视觉正确。

只有单页单用资源时可以使用页面局部常量，不为一次使用创建全局抽象。

## 使用示例

### 登录界面

```csharp
var loginScreen = VStack(20,
    Label("欢迎登录")
        .FontSize(32).Bold().Center().Margin(0, 50, 0, 30),
    VStack(15,
        Label("用户名").Background(Colors.Surface).Padding(15, 10).StretchHorizontal().Height(40),
        Label("密码").Background(Colors.Surface).Padding(15, 10).StretchHorizontal().Height(40)
    ).Margin(40, 0),
    HStack(20,
        Button().Size(120, 40).Background(Colors.Secondary),
        Button().Size(120, 40).Background(Colors.Primary)
    ).Center().Margin(0, 30, 0, 0)
).FillParent().Background(Colors.Background);
```

### 工具栏

```csharp
var toolbar = Panel().Size(400, 50)
    .HorizontalSpread()
    .Add(Button("新建"), Button("编辑"), Button("删除"), Button("设置"));
```

## 更多详细信息

完整文档（含仪表板示例、传统 vs 流式对比、性能说明）见 [reference.md](reference.md)。
