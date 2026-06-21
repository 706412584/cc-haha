# codegraph 优先

代码探索/查询优先使用 codegraph MCP 工具（`mcp__codegraph__*`），而不是 grep/glob 逐个读文件。

适用工具：`codegraph_explore`、`codegraph_search`、`codegraph_node`、`codegraph_callers`、`codegraph_callees`、`codegraph_impact`、`codegraph_files`、`codegraph_status`。

若默认调用返回的是其它项目的索引（例如 `layout-editor`），用 `projectPath` 显式指向当前项目：

```
projectPath: C:\Users\70641\cc-haha
```

委派子代理做代码探索时，把这条规则原样写进子代理的 prompt——只读研究代理（Explore/Plan）不加载项目记忆，不会自动知道这条约定。
