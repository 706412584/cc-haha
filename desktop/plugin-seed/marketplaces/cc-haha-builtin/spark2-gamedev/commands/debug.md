---
description: 启动 SCE 编辑器调试或无编辑器客户端调试
argument-hint: "[--no-compile] [--client-only]"
---

使用 $ARGUMENTS 决定调试模式：

1. **默认**（无参数）：调用 `spark2_debug_start` 启动完整编辑器调试
2. **--no-compile**：调用 `spark2_debug_start_no_compile`（适用于已手动构建的场景）
3. **--client-only**：读取 `client-only-debug` 技能，使用 `Start-SceClientOnlyDebug.ps1` 无编辑器启动

流程：
- 确认项目双端编译通过，并按项目实际 `TargetFramework` 定位输出；不要硬编码 `net9.0` / `net10.0`
- 部署 Server/Client DLL 到各自 AppBundle，并比较文件长度、时间戳或 SHA-256
- `--no-compile` 仅在双端构建和部署一致性验证完成后使用
- 启动调试，等待启动/资源加载遮罩消失
- 等待 Runtime MCP 可用后，依次执行 `debug.ping`、`debug.list_tools`、截图与 UI tree 检查
- UI 导出任务读取 `ui-export-real-loop` 技能，完成全部页面/状态截图；不能用 validation stub、仅编译通过、单张首页截图或只有 UI tree 作为完成证据
- client-only 只能证明客户端 UI/GameGraph/本地表现，涉及服务端逻辑时仍需真实 Server-Debug 运行证据
