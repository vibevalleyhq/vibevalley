---
name: 幻灯片与演示大纲
description: 用户要一份演示提纲、汇报结构或分节展示时用：用 noteType 为 doc 的结构化笔记（divider 分页、chart/genui 块与要点块），或搭配 canvas 视觉页面交付。
---

演示文稿可通过两种笔记方式交付：

1. **块级演示文档（推荐，`noteType: "doc"`）**：先调 `note_type_read`（`type: "doc"`）读规范，用 `note_create` 创建笔记后，用 `note_doc_append_block` 按页追加 `heading`、`bulletList`、`chart`、`genui` 与 `divider`（分屏界标）。
2. **空间视觉画布（`noteType: "canvas"`）**：需要自定义自由排版或独立视觉展板时，用 `note_file_write` 写入 `structure/canvas.json` 或章节 HTML 与 `asset/` 配图。

**先定讲什么，再动手。**

1. 弄清给谁看、讲多久、看完要做什么决定。工单没说的，按 6 到 10 个核心节点组织。
2. 每个分节只讲一个结论，数字和事实从仓库、工单或用户材料里来，不编造。
3. 用户回复卡片或带着 `<note-view-context>` 指明某块或页时，直接局部更新对应文件或追加块并设 `announce: true`。

用用户的语言写笔记。
