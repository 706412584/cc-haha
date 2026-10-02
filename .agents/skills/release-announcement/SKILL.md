---
name: release-announcement
description: 从本项目最新的 release-notes Markdown 制作微信群发布短文案与竖版长图，核验贡献者 GitHub ID 并嵌入真实头像。用于版本发布宣传，不负责创建或发布 GitHub Release。
---

# Release announcement

在本仓库调用 `$release-announcement` 时，交付一张可发微信群的 PNG 长图和一段很短的群文案。默认使用 [版式与文案要求](references/editorial-brief.md)；用户另有要求时以用户要求为准。

调用方式：Codex 使用 `$release-announcement`；Claude Code Haha 的终端输入 `/release-announcement`。这两个工具都从项目的 `.agents/skills/` 读取同一份技能。

## 工作流

1. 在仓库根目录运行 `python3 .agents/skills/release-announcement/scripts/release_poster.py scan --repo . --out artifacts/release-posters/latest-scan.json`。它按语义版本比较工作区、当前 Git 历史、本地 `main` 和已有的 `origin/main`，不切换分支、不抓取远程。读取 JSON 中的中文发布说明、来源和 `@GitHubID` 提及；`credit_candidate` 仅表示有明确署名格式，仍需核对上下文。如果来源不是工作区文件，明确告知用户。
   复测旧版本时加 `--version 0.6.6` 并使用独立输出路径，避免覆盖最新版本的 scan 结果。
2. 仅依据该版本的中文 release note 提炼主要功能和关键修复；纯修复版的 `features` 留空，纯功能版的 `fixes` 留空，绝不为了填版式虚构内容。有重要模型或供应商更新时可加一个简短区块。每条信息必须能追溯到原文，压缩表述时保留条件和边界。安装提醒只写原文确有的信息。不要把英文译文重复计数。
3. 对 `credit_candidate: true` 的账号逐个核对发布说明里的贡献项；普通 `@ID` 提及（例如 PR reviewer）不算代码署名。`render` 会通过 GitHub 公共用户 API 校验 ID 并下载真实头像；无法核验时停止并报告，不能臆造头像、错配姓名，不能让图像生成模型重绘头像。正式生成不能使用 `avatar_path` 跳过核验。
4. 按 [数据格式](references/poster-spec.md) 写 `poster-spec.json`，版本必须与 scan 结果一致。运行 `python3 .agents/skills/release-announcement/scripts/release_poster.py render --scan artifacts/release-posters/latest-scan.json --spec <poster-spec.json> --out <poster.png>`。建议输出到 `artifacts/release-posters/v<version>/`，保留已有文件，文件名加版本或修订号。此脚本固定使用紧凑版式绘制准确中文和头像；不要用 imagegen 绘制正文。
5. 写一段适合微信群的短文案，保存为同目录的 `wechat-copy.txt`：版本号 + 1 句主要变化 + 1 句感谢，具体细节交给图片。有本次明确署名的贡献者时感谢代码贡献；没有时只感谢反馈与支持，不暗示本版有特定群友提交。文案不要宣称未核实的下载地址或公开发布状态，也不要自动向群发送。若需要下载入口，先检查对应 GitHub Release 是否存在。
6. 打开成图检查标题、文字换行、头像和 ID 对应、正文是否从顶部很快开始。最后提供 PNG、短文案、所用 release note 来源和任何未核实项。生成物放在被 Git 忽略的 `artifacts/`，不要提交生成图、头像缓存或中间 JSON。

## 图像与环境

默认长图不需要生成式插画：顶部仅有约 230px 的版本标题，直接进入实际有内容的功能或修复区。这样版式与中文文字最稳定。用户明确想增加插画时，可用 imagegen 只生成无字装饰素材，再用脚本绘制全部文字与真实头像；不能让装饰占去首屏。

`scan` 只用 Python 标准库；`render` 需要 Pillow 和可用的中文系统字体。缺依赖时先查看项目已有运行环境，不为一次制图修改生产依赖。GitHub 头像获取是公开只读请求；失败时给出具体账号和原因。
