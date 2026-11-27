---
name: media
description: 多媒体与语音转写笔记原语（Media）：集中管理录音转写、会议纪要、生成配图、播客音频与视频素材。
tags: [note, media]
---

# media：多媒体与转写笔记

`media` 承载音频、图片、语音合成、对话播客及视频理解产物，主入口为 `structure/media.json`。

- 二进制或渲染好的媒体文件存入 `asset/`，并在 `structure/media.json` 记录时间轴转写段落、来源与任务 `jobId`。
- 配合 `media_image_create`、`media_speech_create`、`media_understanding_start` 将生成的媒体归档至笔记目录。

延伸参考：`note_type_read({ type: "media", reference: "format" })`。
