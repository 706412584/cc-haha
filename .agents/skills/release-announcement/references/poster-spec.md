# `poster-spec.json` 格式

运行 `scan` 后，以最新 release note 填写 JSON。字段：

```json
{
  "version": "0.6.7",
  "product": "Claude Code Haha",
  "features": [
    {"title": "侧边对话", "body": "输入 /btw，在右侧开启独立的临时对话，不打断主任务。"}
  ],
  "extras": [
    {"title": "模型与供应商", "headline": "新版模型与映射", "body": "依据本版说明压缩成一句话。"}
  ],
  "fixes": [
    {"title": "超大会话打不开", "body": "超过 20MB 的历史可以继续打开。"}
  ],
  "contributors": [
    {"login": "example-user", "contribution": "此人本次被署名的贡献"}
  ],
  "install_note": "仅在发布说明明确写有安装提醒时填写。",
  "footer_url": "github.com/706412584/cc-haha"
}
```

- `version`、`features`、`fixes`、`contributors` 必填；`extras`、`install_note`、`footer_url` 可省略。纯修复版填 `"features": []`，纯功能版填 `"fixes": []`，两者不能同时为空。没有署名贡献者时 `contributors` 为 `[]`。
- `render --scan` 会校验版本及贡献者 ID 必须是 release note 中文部分的明确署名候选。普通提及不算署名；不要把示例 ID 写入真实结果。
- 测试或离线排版时，贡献者可以另给 `avatar_path` 并显式传 `--allow-offline-avatars`；正式生成禁止该选项，必须实时核验公开 GitHub 账号与头像。
- 正式图保留所有已核验、已署名的贡献者；如果名字很多，可以缩短每人的贡献概述，不能遗漏账号或用假头像填位。
