---
name: media-api
description: >-
  media-gen 工具协议参考。用于客观选择工具并映射 provider、模型、图片尺寸、视频时长、图生视频和视频扩展参数；不修改用户 prompt 或补充创意内容。
---

# Media API 协议参考

本 skill 只提供协议事实和确定性参数映射。不得扩写、翻译或优化用户 prompt，除非用户明确要求。

## 通用选择

- `generate_image`：文生图。
- `edit_image`：编辑已有图片。
- `generate_video`：文生视频或图生视频。
- `edit_video`：按 prompt 修改已有 Grok MP4。
- `extend_video`：延长已有 Grok MP4。
- `list_providers`：查看 provider 索引、默认模型与能力。
- `list_models`：从 provider `/models` 查询模型。

`provider_index` 是当前排序下的 0-based 索引；`provider_id` 是不受排序影响的稳定 ID。两者同时提供时必须指向同一 provider。`model` 覆盖必须与其中一个 provider 选择器同时使用。显式选择 provider 后不跨 provider fallback；未显式选择时，图片工具只在已启用且配置了对应图片模型的 provider 间 fallback，视频工具始终要求显式 provider。

每类工具使用独立默认模型：`generate_image` → `imageGeneration`、`edit_image` → `imageEditing`、`generate_video` → `videoGeneration`、`edit_video` → `videoEditing`、`extend_video` → `videoExtension`。显式 `model` 优先。

## 图片生成

### OpenAI-compatible 图片 provider

使用：

- `size`：如 `1024x1024`、`1536x1024`、`1024x1536`，具体值由模型能力决定。
- `n`：生成数量。
- `transparent`：仅支持透明背景的模型可用。

### Grok Imagine 图片

模型包括 `grok-imagine-image`、`grok-imagine-image-quality`。

不要发送 `size`；使用：

- `aspect_ratio`：`1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3`、`2:1`、`1:2`、`19.5:9`、`9:19.5`、`20:9`、`9:20`、`auto`。
- `resolution`：`1k` 或 `2k`。

用户未指定比例或分辨率时不推断，交给 provider 默认值。

## 图片编辑

- 工具：`edit_image`。
- 必填：`prompt`、`image_url`。
- Grok 编辑模型：`grok-imagine-edit`。
- `image_url` 支持工具 schema 声明的 URL 或 Data URL。

## 视频生成

视频必须指定 `provider_index`。`model` 可覆盖该 provider 默认模型。

### Grok

模型：`grok-imagine-video` 及其后缀版本。

- 文生视频：`prompt`。
- 图生视频：额外传 `image_url`；已验证 JPEG Data URL 可用。
- `duration`：1–15 秒，默认 8。
- `aspect_ratio`：provider 支持的视频比例。
- `resolution`：`480p` 或 `720p`。
- 创建：`POST /videos/generations`。
- 轮询：`GET /videos/{request_id}`。

不要把 Agnes 的 `image` 字段用于 Grok。

### Agnes-compatible

- 图生视频参考图使用 `image`，不是 `image_url`。
- 可选协议字段：`mode`、`height`、`width`、`num_frames`、`frame_rate`、`num_inference_steps`、`seed`、`negative_prompt`。
- 创建：`POST /videos`。
- 轮询：`GET /agnesapi?video_id=...`。

不要把 Grok 的 `image_url` 字段用于 Agnes。

## Grok 视频编辑

工具：`edit_video`。

必填：

- `prompt`：编辑要求，保持用户原文。
- `video_url`：公网 MP4 URL 或 `video/mp4` Data URL。
- `provider_index`：Grok provider。

可选 `model` 覆盖选中 provider 的默认 Grok 视频模型。创建 endpoint 为 `POST /videos/edits`，请求体为 `model`、`prompt`、`video: { url }`；轮询复用 `GET /videos/{request_id}`。

## Grok 视频扩展

工具：`extend_video`。

必填：

- `prompt`：描述后续内容，保持用户原文。
- `video_url`：公网 MP4 URL 或 `video/mp4` Data URL。
- `provider_index`：Grok provider。

可选：

- `model`：Grok 视频模型。
- `duration`：1–10 秒，默认 6。
- `output_upload_url`：映射到 `output.upload_url`。

输入视频限制：MP4，2–30 秒。创建 endpoint 为 `POST /videos/extensions`，轮询复用 `GET /videos/{request_id}`。

## 客观性约束

- 不从主体类型推断风格或宽高比。
- 不从“好看”“高质量”等模糊要求添加模型参数以外的 prompt 内容。
- 不擅自降低分辨率、缩短时长、切换模型或 provider。
- 参数无效时报告合法值；只有用户同意后才修改并重试。
