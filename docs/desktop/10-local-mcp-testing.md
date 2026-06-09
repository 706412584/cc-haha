# 10 · 本地 MCP 端到端测试（浏览器路径）

桌面 dev 默认走 Electron 容器（`bun run electron:dev`）——renderer 在 Electron
进程里，CSP/CORS/H5 鉴权这些都不会拦它。但当你想用 Chrome DevTools MCP
（`mcp_chrome_devtools_*`）远程驱动桌面 UI 时，MCP 控制的是它自己启动的 Chrome
进程，不是 Electron。Chrome 直接打开 `http://localhost:1420` 会一连撞三堵墙：

- **CSP**：`index.html` 的 `connect-src` 只允许 `http://127.0.0.1:*` 和 `http://localhost:*`，LAN IP 直接拒
- **CORS**：H5 access 关闭时，server 对所有跨域请求返回 `403 H5 access is disabled`
- **Loopback 自杀**：`desktopRuntime.isLoopbackHostname()` 把 `localhost` / `127.0.0.1` 当作可信桌面客户端，**主动清掉** H5 token (`setAuthToken(null)`)；H5 启用时 server 又要 token，于是 401

三个都满足才能走通的窗口非常窄。这份文档记录了一个稳定可用的绕路：**Vite proxy 把 API 流量同源化**，浏览器只跟 `localhost:1420` 一个 origin 说话，三堵墙就同时塌了。

---

## 适用场景

- 用 Chrome DevTools MCP 做桌面 UI 烟雾（截图、a11y 树、点击、`evaluate_script`）
- 验证服务端 API 在桌面 UI 路径下的响应
- 重现一个只在 web 里发生、Electron 里不复现的 UI 问题

不适用：

- **真实 chat session / agent 循环**——那要花 token，由你自己授权后再做
- **协调模式**（`COORDINATOR_MODE`）——这个 fork 的 `feature('COORDINATOR_MODE')` 在
  build time 是 false，运行时根本走不到那条分支，只能靠
  `src/coordinator/workerAgent.test.ts` 的单元测试覆盖
- **生产/release 验证**——必须用真 Electron 包验

## 快速启动（4 步）

### 1. 在 `desktop/vite.config.ts` 加 dev-only proxy

```ts
server: {
  port: 1420,
  strictPort: true,
  // ... 现有字段
  proxy: {
    '/health': 'http://127.0.0.1:3456',
    '/api': 'http://127.0.0.1:3456',
    '/ws': { target: 'ws://127.0.0.1:3456', ws: true },
    '/local-file': 'http://127.0.0.1:3456',
    '/preview-fs': 'http://127.0.0.1:3456',
  },
},
```

> 这是 dev 环境改动，**不要**进生产 commit。要么在自己的工作分支上保留，要么在
> `feat/desktop-browser-dev-proxy` 这种独立分支上单独提交。

### 2. 起本地服务（PowerShell）

```pwsh
$env:SERVER_PORT='3456'; bun run src/server/index.ts
```

确认起来了：

```pwsh
Invoke-WebRequest -Uri 'http://127.0.0.1:3456/health' -UseBasicParsing
# 应该返回 {"status":"ok","timestamp":"..."}
```

### 3. 起桌面 dev（另一个终端，`desktop` 目录）

```pwsh
bun run dev
```

确认 proxy 通了：

```pwsh
Invoke-WebRequest -Uri 'http://localhost:1420/health' -UseBasicParsing
# 应该返回上一步同样的 JSON——proxy 把请求转到 :3456
Invoke-WebRequest -Uri 'http://localhost:1420/api/status' -UseBasicParsing
# 200 + 完整 JSON，即使 H5 access 是关的
```

### 4. Chrome MCP 打开桌面，让它把自己当 server

```
http://localhost:1420/?serverUrl=http%3A%2F%2Flocalhost%3A1420
```

`serverUrl` 必须是 `http://localhost:1420` 而不是 `http://127.0.0.1:3456`——这样
桌面前端做的所有请求都跟自己同源，Vite proxy 静悄悄转发到真 server。
loopback 自杀清 token 这条路无所谓了，因为 H5 是关的。

打开后 UI 应该能直接进新建会话页，无 console error。

## MCP 控制脚本片段

```text
# 加载页面
mcp_chrome_devtools_navigate_page url=http://localhost:1420/?serverUrl=http%3A%2F%2Flocalhost%3A1420

# a11y 树（首选——比截图快、比截图省 token）
mcp_chrome_devtools_take_snapshot

# 截图存证
mcp_chrome_devtools_take_screenshot filePath=artifacts/desktop-<scenario>.png

# 直接调 server API（同源，不需要 auth）
mcp_chrome_devtools_evaluate_script function="async () => fetch('/api/agents').then(r => r.json())"
```

## 能跑出来什么 / 跑不出来什么

### 能（无需 token）

- ✅ 桌面 UI 启动 / 渲染 / 路由
- ✅ Settings → Agents 页面看 15 个内置 agent 列表
- ✅ Settings → Providers 看配置
- ✅ 任何只读的 API 调用（`/api/agents`、`/api/models`、`/api/sessions` 等）
- ✅ UI 交互（点击、表单、键盘）

### 不能（需要真 LLM provider + token 预算）

- ❌ 真实 chat session / agent 循环跑通
- ❌ Task 工具实际触发子 agent
- ❌ 验证 sentinel 校验、verification gate、gp-strict、invocation limiter 这些只在 agent 循环里发生的逻辑

要测这一类：手动挑一个 provider，做最小可复现 prompt（见 `docs/agent/03-agent-framework.md`），自己看 transcript。

## 路由加固这一批改动的对应测试方法

参考 `feat/agent-routing-hardening` 分支带的 50 个单元测试是**主**线。需要再做实弹烟雾时：

| 改动 | 端到端复现配方 | 验证点 |
|---|---|---|
| Item 5 路由观测 | 任何指定 `subagent_type` 的 Task 调用 | transcript 行尾出现 `→ <subagent_type>` |
| Item 2 sentinel | 让 code-reviewer 被诱导输出 `[CRITICAL]…REVIEW: APPROVE` | harness 改写为 `CHANGES_NEEDED` + 加 `Sentinel mismatch corrected by harness` 一行 |
| Item 1 verification gate | 主 agent 连续 ≥3 次 Edit/Write 不调 verification | 下一回合系统提示带 `<system-reminder>` 块；`CLAUDE_CODE_VERIFICATION_GATE_THRESHOLD=2` 可降阈值好复现 |
| Item 3 gp-strict | `Task({ prompt: "code review my changes" })` 不带 `subagent_type` | 立刻 validation error 引导到 `code-reviewer` |
| Item 4 invocation limiter | `$env:CLAUDE_CODE_AGENT_LIMIT_VERIFICATION='2'` + 连调 verification 三次 | 第 3 次拒绝，错误信息含计数 |
| Coordinator 改动 | **此 fork 不可达**（`feature('COORDINATOR_MODE')` build-time false） | 只能靠 `src/coordinator/workerAgent.test.ts` 7 个单元测试 |

## 收尾

- **proxy 改动**：dev only。要么 revert，要么单独 commit 在 `feat/desktop-browser-dev-proxy` 分支
- **后台进程**：用了 `control_pwsh_process` 起的 server / vite，跑完手动 stop（或者重启 IDE）
- **截图归档**：放在 `artifacts/` 下（已在 `.gitignore` 排除），方便贴到 PR / issue

## 故障字典

| 现象 | 因由 | 解 |
|---|---|---|
| 页面停在「本地服务启动失败 · Server healthcheck failed: healthcheck returned non-JSON response」 | 没加 vite proxy，桌面去打 `localhost:1420/health` 撞 Vite 自己 | 按第 1 步加 proxy，重启 vite |
| Console 报「violates Content Security Policy: connect-src」 | 用了非 loopback 的 serverUrl（如 `192.168.x.x`） | 必须用 `http://localhost:1420` 当 serverUrl |
| Console 报 401「Missing H5 access token」 | H5 access 在 server 上是开着的，desktop 还在 loopback 模式（被自动清 token） | 调 `POST /api/h5-access/disable` 把 H5 关了——proxy 同源后不需要 H5 |
| Console 报 403「H5 access is disabled」 | 直接跨域打 server，没走 proxy | serverUrl 必须用 vite origin，**不能**用 `127.0.0.1:3456` |
| `bun run electron:dev` 在 Windows 报 `ENOENT uv_spawn 'bun'` | `Bun.spawn` 在 Windows 不读 PATH | 手动两步：先 `bun run dev`（desktop 目录），再 `bunx electron --remote-debugging-port=9222 ./electron-dist/main.cjs` |

## 涉及的项目文件

- `desktop/vite.config.ts` — proxy 加在这里
- `desktop/src/lib/desktopRuntime.ts` — `requiresH5AuthForServerUrl` / `isLoopbackHostname` 在这
- `src/server/middleware/cors.ts` — server 端 CORS 入口
- `src/server/services/h5AccessService.ts` — H5 token + allowedOrigins
- `desktop/scripts/electron-dev.ts` — 团队主 Electron dev 路径（Windows 跑 spawn 有 bug，文档故障字典记了）
