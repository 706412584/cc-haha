# 插件开发规范

适用于 cchh 内置插件（`plugins/*`）的 skill/agent/manifest 改动。源自一次真实教训：新增 skill 目录后，agent frontmatter 漏写已有 skill，导致目录数与 agent 声明不一致。

## 新增 / 修改插件 skill 的 checklist

每次新增或修改插件 skill 时，按顺序确认：

1. 新增或编辑 `skills/<skill>/SKILL.md`，frontmatter 含 `name` / `description` / `whenToUse` / `allowedTools`。
2. 若 agent 需要路由到它，更新对应 agent 的 frontmatter `skills:` 列表。
3. 更新 `README` 能力矩阵、技能计数与使用说明。
4. 若需刷新插件缓存，bump `.claude-plugin/plugin.json` 的 `version`（缓存按 manifest version 物化）。
5. 运行插件 validate（如 `./bin/claude-haha plugin validate plugins/<plugin>`）。
6. 运行 `git diff --check` 检查空白/冲突标记。
7. 对比实际 `skills/*/SKILL.md` 目录与 agent frontmatter `skills:`，确保无 missing / extra。
8. 校验 `README` 声明的技能数与实际目录数一致。

## 三方一致性

`skills/` 目录、agent frontmatter、README 能力列表三者必须同步。

- 只新增 SKILL.md 文件而不更新 agent frontmatter，会导致「目录里有但 agent 不路由」。
- `plugin validate` 只验证 manifest schema，不会发现目录与 agent skills 数量不一致，需额外做一致性探针。

## 验证边界

- 用 git worktree 隔离的验证子代理默认从 HEAD 拉取，看不到未提交改动；验证当前工作区时必须显式指向主工作区绝对路径（如 `C:\Users\70641\cc-haha`），否则会验到旧拷贝。
- 自己的检查和 fork 的自检不能替代独立验证；跨过编辑阈值时用 verification 子代理独立复核。
