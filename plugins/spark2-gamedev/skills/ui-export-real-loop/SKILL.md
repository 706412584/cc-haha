---
name: ui-export-real-loop
description: Validate exported Spark2/GameUI screens in a real Client-Debug runtime. Use for C# UI exports, black bars or scale mismatch, all-page screenshot comparison, WebP compatibility, NineSlice, ZIndex, hidden controls, and resource reachability.
when_to_use: 当 UI 从布局器或其他工具导出到 Spark2 C#，并且需要真实双端编译、AppBundle 部署、Runtime MCP、逐页截图和视觉验收时使用。
allowed-tools: Bash, Read, Glob, Grep, Edit, Write
---

# Spark2 UI 导出真实闭环

本技能验证“导出的 UI 在真实 Spark2 客户端中正确显示”，不是只验证代码形状。先结合 [UI 布局 API](../ui-layout-api/SKILL.md)、[调试工具](../debug-tools/SKILL.md) 和 [纯客户端调试](../client-only-debug/SKILL.md) 使用。

## 证据等级

以下证据互不等价，低等级不能替代高等级：

1. 插件结构校验、导出 manifest、ValidationStubs：只证明结构或静态契约。
2. `Client-Debug` / `Server-Debug`：只证明真实 SDK API 能编译。
3. AppBundle 文件长度、时间戳或 SHA-256：证明最新 DLL 已部署。
4. `debug.ping` 和运行时日志：证明真实客户端已加载并运行。
5. `ui.snapshot` / `ui.find` / `ui.get_rect`：证明 GameUI 控件树、可见性和像素矩形。
6. `debug.capture_screenshot`：证明最终视觉结果；Canvas 直接绘制内容以截图为主证据。
7. 全页面清单和逐页截图：证明不是只验证默认首页。

UI 导出验收至少需要真实双端 build、DLL 部署、Runtime MCP、关键 UI tree 和全部可访问页面截图。只通过 stub、validation 或一张首页截图时，必须报告“未完成真实闭环”。

## 1. 先固定设计分辨率和启动窗口

记录以下字段后再解释黑边：

- 项目 `designWidth` / `designHeight`
- `ScaleMode`
- client-only `-width` / `-height`
- 截图 `sourceWidth` / `sourceHeight`
- `ui.snapshot` 中 root 的像素 rect
- 是否存在 safe zone 或引擎启动遮罩

`MatchHeight` 固定高度缩放，宽度按比例计算。若设计为 `1080x1920`，在宽高比不同的窗口中出现左右留白可能是预期 pillarbox，不是 Margin 错误。`810x1440` 与 `1080x1920` 都是 9:16，可用于等比例竖屏验收：

```text
810 / 1440 = 1080 / 1920 = 0.5625
```

诊断顺序：

1. 比较设计宽高比与实际 source 宽高比。
2. 用 `ui.snapshot` 确认 root 是否填满 GameUI viewport。
3. 从截图判断黑色区域位于 viewport 外、root 外，还是背景控件内部。
4. 只有 root rect 或背景 rect 错误时才改布局；不要用额外 Margin、拉伸图片或任意扩大 root 掩盖正常 letterbox。

## 2. 使用真实 TargetFramework 构建和部署

不要硬编码 `net9.0`、`net10.0` 或其他 TFM。先读取 `src/GameEntry.csproj` 的 `TargetFramework` / `TargetFrameworks`，或让 MSBuild 输出当前配置的 `TargetPath`：

```powershell
$ProjectRoot = "D:\Maps\MyMap"
$Project = Join-Path $ProjectRoot "src\GameEntry.csproj"

dotnet build $Project -c Server-Debug
dotnet build $Project -c Client-Debug

$ServerTarget = dotnet msbuild $Project -nologo -getProperty:TargetPath -property:Configuration=Server-Debug
$ClientTarget = dotnet msbuild $Project -nologo -getProperty:TargetPath -property:Configuration=Client-Debug
```

若项目解析出的 TFM 是 `net10.0`，输出通常位于 `src/bin/<Configuration>/net10.0/GameEntry.dll`；这只是示例，仍以 `TargetPath` 为准。

部署必须保持双端对应：

```powershell
$ServerDestination = Join-Path $ProjectRoot "AppBundle\managed\GameEntry.dll"
$ClientDestination = Join-Path $ProjectRoot "ui\AppBundle\managed\GameEntry.dll"
Copy-Item -LiteralPath $ServerTarget -Destination $ServerDestination -Force
Copy-Item -LiteralPath $ClientTarget -Destination $ClientDestination -Force
```

Server-Debug DLL 不能复制到 client 目录，Client-Debug DLL 也不能复制到 server 目录。部署后至少比较长度和 `LastWriteTimeUtc`；对高风险或疑似旧 DLL 问题，比较 SHA-256：

```powershell
Get-FileHash -Algorithm SHA256 $ServerTarget, $ServerDestination
Get-FileHash -Algorithm SHA256 $ClientTarget, $ClientDestination
```

哈希不一致时不得启动 `debug_start_no_compile` 或 client-only 验收。

## 3. Runtime MCP 证据链

启动客户端后按固定顺序验证：

1. `debug.ping`：确认 bridge 可达、`client_only` / `debug` / `map_path` 符合预期。
2. `debug.list_tools`：以真实客户端返回的工具列表为准，不猜工具名。
3. `debug.capture_screenshot`：保存原始或适当降采样截图。
4. `ui.snapshot`：读取 GameUI tree、文本、可见性和 rect。
5. 必要时用 `ui.find` / `ui.get_rect` 定位具体控件。

通过外层 SCE MCP 调用时先检查外层 `result.isError`，再解析内层 JSON 的 `success`。外层调用成功但内层 `success=false` 仍是失败。

Canvas 直接绘制内容可能不出现在 `ui.snapshot` 中。此时截图是 Canvas 内容的主证据，UI tree 只验证外围 GameUI 容器、遮罩和控件。

### 3.1 真实按钮点击：优先使用项目级受限工具

官方 Runtime MCP 当前通常只提供查询与截图工具，不应猜测存在 `ui.click`。先调用 `debug.list_tools`；若没有官方点击工具，但验收必须证明按钮真实触发了绑定动作，可按 `docs/sdk/guides/RuntimeMcpDebugGuide.md` 使用 `RuntimeDebugToolRegistry.Register` 注册项目级受限工具，例如：

```text
project.ui.click_node
```

该工具必须满足以下安全边界：

1. 只接受当前页面导出节点表中的 `nodeId`，不能接受任意 `actionId`。
2. 节点必须存在、`IsValid` 且 `IsActuallyFunctional`。
3. 只能调用导出阶段已经通过 `BindAction` 绑定的 handler；禁止 `eval`、反射、动态代码或任意宿主命令。
4. 页面切换后旧节点不得继续可调用。动作映射优先使用 `ConditionalWeakTable<Control, ...>`，避免延长控件生命周期。
5. 返回 `node_id`、`action_id`、`screen_before` 和 `screen_after`，让导航结果可断言，而不是只返回“点击成功”。
6. 重复 `BindAction` 不得叠加多个点击订阅；更新同一控件绑定时应复用可变绑定记录。

推荐的项目实现边界：

```csharp
if (!currentNodes.TryGetValue(nodeId, out var node) || !node.IsValid)
{
    throw new RuntimeDebugToolException("node_not_found", "Current node not found.");
}

if (!node.IsActuallyFunctional)
{
    throw new RuntimeDebugToolException("node_not_functional", "Node is not interactive.");
}

if (!LayoutRuntime.TryInvokeBoundAction(node, out var actionId))
{
    throw new RuntimeDebugToolException("node_has_no_action", "Node has no bound action.");
}
```

验收顺序固定为：

1. `debug.list_tools` 确认自定义工具来自当前客户端，不凭源码猜测已注册。
2. 点击入口节点，断言 `screen_before`、`action_id`、`screen_after`。
3. 进入二级页后点击 `btn_back`，断言回到预期一级页。
4. 选一个当前页签执行同页点击，确认没有无意义重建或状态重置。
5. 选一个不存在、隐藏或不可交互节点，确认工具拒绝调用。
6. 检查运行日志中没有 `unknown action`、异常或资源缺失。

`OnPointerClicked` 是订阅事件，不等同于公开的事件 Raise API。不要用 Win32 `PostMessage`、系统鼠标注入或任意坐标点击冒充 GameUI 动作闭环；若客户端输入层不接收这些事件，应使用上述受限项目工具。

## 4. 全页面与全状态截图

不能只截默认首页。先建立页面清单，包括页面 id、名称、稳定标识和期望截图文件名；再逐页执行：

1. 导航到目标页面。
2. 等待页面 id/隐藏 validation marker/UI 文本变化，确认不是上一页残留。
3. 等待布局和资源稳定。
4. 若仍显示“游戏启动完成”、进度条、资源加载或网络遮罩，继续等待或明确标为遮罩截图，不能冒充页面截图。
5. 采集 `ui.snapshot` 和 screenshot。
6. 写入 manifest，并校验页数、唯一 id 和文件存在。

推荐稳定命名：

```text
runtime/01-title.png
runtime/02-home.png
snapshots/01-title.json
runtime-manifest.json
```

临时轮播入口仅用于验收。完成后必须恢复正式启动入口并重新 build/deploy；停止 client-only 或调用 `debug_stop`，避免残留客户端占用端口。

## 5. 图片格式：WebP 必须真实转 PNG

当前 Spark2 GameUI 验收中，不要假设 WebP 可由 UI 图片加载器直接显示。若编辑器资源是 WebP：

1. 用真实解码器读取 WebP 像素。
2. 重新编码为 PNG。
3. 将 C# 资源引用和最终文件扩展名同步改为 `.png`。
4. 检查 PNG magic bytes：`89 50 4E 47 0D 0A 1A 0A`，并实际解码确认尺寸。
5. 重新部署资源并在客户端截图确认。

只把 `foo.webp` 重命名为 `foo.png` 不会改变内容格式，不能视为转码。文件存在、路径正确或导出器 validation 通过也不能证明 GameUI 已渲染图片。

## 6. NineSlice 必须做实机视觉验证

NineSlice API 或属性存在只证明配置已生成。至少选择一个有明显四角/边框/中心纹理的资源，在真实客户端验证：

- 接近原图尺寸的小控件
- 横向拉伸
- 纵向拉伸
- 横纵同时拉伸

检查：

- 四角保持尺寸与形状
- 上下左右边缘只沿正确方向拉伸
- 中心区域按预期填充
- 控件尺寸不小于固定边界之和
- 没有整图等比缩放、边框变粗或中心纹理变形

截图应同时保留控件 rect 与 slice 参数，便于区分“API 未生效”和“参数不适合该资源”。

## 7. ZIndex、隐藏状态与背景遮挡

Canvas 绘制顺序与 GameUI 控件 `ZIndex` 是两套机制。背景覆盖文字或按钮时联合检查：

- 父子关系
- 创建/挂载顺序
- `ZIndex`
- `Visible`
- 控件 rect
- 最终截图

背景应处于内容后方。仅在 tree 中找到前景控件不代表它没有被背景遮挡。

从 Web/CSS 导出到 GameUI 时，`display:none` 应映射为 `Visible=false`（或 `.Hidden()`），不能把 CSS 字符串原样交给 GameUI。隐藏状态必须同时满足：

- `ui.snapshot` 显示该控件不可见
- screenshot 中无残留绘制

若隐藏的是父容器，还要检查子控件是否随父容器隐藏。

## 8. 远程资源闭环边界

将远程资源验证拆成五级：

1. URL/资源引用存在
2. 下载请求成功
3. 文件内容与格式有效
4. 引擎资源对象加载并被控件使用
5. 最终截图中真实出现

只完成前三级时不能宣称远程 UI 资源闭环。编辑器预览成功也不能替代 client-only 结果。

资源路径遵循 Spark2 边界：UI 图片位于项目 `ui/`，代码从 `image/...` 开始；普通 JSON/文本可用 `user_files`，但不要把 GameUI 图片、Spine、模型、粒子或音频放进 `user_files` 冒充引擎资源。

网络不可用时可用本地 fixture 验证布局，但报告必须写明“本地 fixture 验证”，不能冒充远程加载已通过。不要为一次 UI 修复顺带扩展未闭环的远程 Spine/atlas/纹理重写系统。

## 9. 完成标准

UI 导出完成报告至少包含：

- 真实 design resolution、scale mode、启动 source size
- Client-Debug / Server-Debug 构建结果
- 双端 DLL TargetPath 和部署一致性证据
- `debug.ping` 与 `debug.list_tools` 结果
- 关键入口、返回和同页点击的 `project.ui.click_node` 断言结果（若项目注册了该工具）
- 页面清单、截图数量、UI snapshot 数量和产物目录
- WebP/PNG 数量与格式检查结果
- NineSlice、ZIndex、Visible 的实机结论
- 未验证的远程资源或服务端运行边界
- 已恢复临时轮播/测试入口并停止调试进程

只有这些证据来自当前构建和当前运行时，才能报告真实闭环完成。
